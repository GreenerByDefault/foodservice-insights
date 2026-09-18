#!/usr/bin/env python3
"""Estimate the monthly bill for transactional email on Resend, Postmark, SES, and SendGrid.

    uv run scripts/email_costs.py

Three things drive the estimate, and each lives in its own section below so it can be changed
on its own:

1. **Volume drivers** — what makes the product send an email, and how often. Every number is a
   guess until production has run for a month; replace them with figures from the provider's
   dashboard then.
2. **Scenarios** — how many users, reports, and new organizations a month carries.
3. **Prices** — each provider's public list price, snapshotted on `PRICES_AS_OF` with the page
   it came from. They drift; re-check before quoting one.

Two things about this bill are worth knowing before reading the output.

**Sign-in codes are on it.** Auth is email OTP (REQUIREMENTS.md § Authentication mechanism), and
Supabase Auth's built-in mailer is capped at 2 messages/hour and disclaims any delivery SLA, so
production has to point Supabase at custom SMTP — the same provider, the same quota, the same
bill. Logins, not reports, are usually the larger half.

**The monthly total is rarely what picks the plan.** A free tier caps a *day* as well as a
month, and report uploads cluster, so `PEAK_DAY_SHARE` is what decides whether one fits.

Left out on purpose: dedicated IPs (nothing here sends near the volume that warrants one) and
inbound/webhook processing (we parse no mail).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Final

PRICES_AS_OF: Final = "2026-09-16"

# ------------------------------------------------------------------
# Volume drivers
# ------------------------------------------------------------------

# Every sign-in sends a one-time passcode, so an active user costs email even in a month they
# never run a report. Sessions outlive a single visit, so this is sessions started, not visits.
LOGINS_PER_USER_PER_MONTH: Final = 4.0

# A code that arrives late, or lands in spam, makes the user ask for another. Supabase enforces a
# 60-second cooldown per address, so this is bounded by impatience rather than by a retry loop.
# It is also the one line that a slow provider inflates: worse latency here means a bigger bill.
EXTRA_CODE_RATE: Final = 0.2

# One result email per report that reaches a terminal state. Canceled attempts get none
# (REQUIREMENTS.md § User email). The notification sweep's retries only send when a send failed,
# which is rare enough to leave out.
NOTIFICATIONS_PER_REPORT: Final = 1.0

# An invite, plus the occasional re-invite when the first is missed or expires. A re-invite is a
# second email to the same address (REQUIREMENTS.md § Invite flow).
EMAILS_PER_INVITE: Final = 1.3

# Organization created, organization deleted, user deleted, all to the one GBD address
# (REQUIREMENTS.md § GBD email notifications). Scaled off new organizations, since creation is
# the common one and deletions trail it.
GBD_NOTICES_PER_NEW_ORG: Final = 1.5

# What share of a month's email the busiest day carries. A flat month would be 1/30 ≈ 0.03, but
# uploads cluster — a client works through a quarter of data in one sitting, and a newly invited
# team all signs in the same afternoon. Only free tiers meter a day, so this number moves nothing
# else.
PEAK_DAY_SHARE: Final = 0.15


@dataclass(frozen=True)
class Volume:
    """A month's email, split by what asked for it."""

    sign_in_codes: float
    result_notifications: float
    invites: float
    gbd_notices: float

    def sources(self) -> tuple[tuple[str, float], ...]:
        return (
            ("sign-in codes (Supabase Auth, over SMTP)", self.sign_in_codes),
            ("result notifications", self.result_notifications),
            ("invites", self.invites),
            ("GBD notices", self.gbd_notices),
        )

    def total(self) -> float:
        return sum(count for _, count in self.sources())

    def peak_day(self) -> float:
        return self.total() * PEAK_DAY_SHARE


@dataclass(frozen=True)
class Scenario:
    name: str
    users: int
    reports_per_month: int
    new_users_per_month: int
    new_orgs_per_month: int

    def volume(self) -> Volume:
        return Volume(
            sign_in_codes=self.users * LOGINS_PER_USER_PER_MONTH * (1 + EXTRA_CODE_RATE),
            result_notifications=self.reports_per_month * NOTIFICATIONS_PER_REPORT,
            invites=self.new_users_per_month * EMAILS_PER_INVITE,
            gbd_notices=self.new_orgs_per_month * GBD_NOTICES_PER_NEW_ORG,
        )


# ------------------------------------------------------------------
# Scenarios
# ------------------------------------------------------------------

# The report counts track scripts/hosting_costs.py, so the two estimates describe the same months.

SCENARIOS: Final = (
    Scenario(
        "Launch: ~10 users, ~100 reports/month",
        users=10,
        reports_per_month=100,
        new_users_per_month=3,
        new_orgs_per_month=2,
    ),
    Scenario(
        "Planned: ~40 users, ~500 reports/month",
        users=40,
        reports_per_month=500,
        new_users_per_month=8,
        new_orgs_per_month=3,
    ),
    Scenario(
        "Growth: ~150 users, ~2,000 reports/month",
        users=150,
        reports_per_month=2_000,
        new_users_per_month=25,
        new_orgs_per_month=6,
    ),
)


# ------------------------------------------------------------------
# Prices and the per-provider bill
# ------------------------------------------------------------------


@dataclass(frozen=True)
class LineItem:
    label: str
    dollars: float


Bill = tuple[LineItem, ...]


@dataclass(frozen=True)
class Plan:
    name: str
    dollars_per_month: float
    included_emails: int
    # None means the plan has no overage: it stops at `included_emails` rather than billing past
    # it, so it is only usable below that. Every free tier here works this way.
    overage_per_1k: float | None
    # Free tiers meter a day as well as a month. None means only the monthly figure applies.
    daily_cap: int | None = None

    def fits(self, volume: Volume) -> bool:
        if self.daily_cap is not None and volume.peak_day() > self.daily_cap:
            return False
        return self.overage_per_1k is not None or volume.total() <= self.included_emails

    def cost(self, volume: Volume) -> float:
        if self.overage_per_1k is None:
            return self.dollars_per_month
        overage_thousands = max(0.0, volume.total() - self.included_emails) / 1000
        return self.dollars_per_month + overage_thousands * self.overage_per_1k


def cheapest_plan(plans: Iterable[Plan], volume: Volume) -> Plan:
    fitting = [plan for plan in plans if plan.fits(volume)]
    if not fitting:
        raise ValueError(f"No plan fits {volume.total():,.0f} emails/month")
    return min(fitting, key=lambda plan: plan.cost(volume))


def plan_bill(plans: Iterable[Plan], volume: Volume) -> Bill:
    """The bill for whichever of a provider's plans is cheapest at this volume."""
    plan = cheapest_plan(plans, volume)
    items = [LineItem(f"{plan.name} ({plan.included_emails:,} included)", plan.dollars_per_month)]
    overage = plan.cost(volume) - plan.dollars_per_month
    if overage > 0:
        billed = volume.total() - plan.included_emails
        items.append(LineItem(f"overage ({billed:,.0f} emails)", overage))
    return tuple(items)


# --- Resend ---------------------------------------------------------
# https://resend.com/pricing. The free tier meters 100 emails/day as well as 3,000/month, and has
# no overage — it stops. Data retention is 30 days on every plan. Seats are unlimited on Pro.
RESEND_PLANS: Final = (
    Plan("Free", 0.0, 3_000, overage_per_1k=None, daily_cap=100),
    Plan("Pro 50k", 20.0, 50_000, overage_per_1k=0.90),
    Plan("Pro 100k", 35.0, 100_000, overage_per_1k=0.90),
)


def resend(volume: Volume) -> Bill:
    return plan_bill(RESEND_PLANS, volume)


# --- Postmark -------------------------------------------------------
# https://postmarkapp.com/pricing. The $0 Developer tier is 100 emails/month — a test allowance,
# not a plan to run on. Basic and Pro both start at 10,000 emails and differ in overage rate and
# retention (45 days on Basic; up to 365 on Pro). Only the entry rung of the volume ladder is
# published, so above 10,000 this models the overage rate rather than the next rung, which is
# likely a little pessimistic.
POSTMARK_PLANS: Final = (
    Plan("Developer", 0.0, 100, overage_per_1k=None),
    Plan("Basic 10k", 15.0, 10_000, overage_per_1k=1.80),
    Plan("Pro 10k", 16.50, 10_000, overage_per_1k=1.30),
)


def postmark(volume: Volume) -> Bill:
    return plan_bill(POSTMARK_PLANS, volume)


# --- Amazon SES -----------------------------------------------------
# https://aws.amazon.com/ses/pricing/. Pure metering, no plan fee and nothing included: $0.10 per
# 1,000 emails, flat at every volume. New accounts get 3,000 messages/month for their first 12
# months, left out here because it expires. What the price excludes is the point: no message log
# or search UI, and bounce and complaint handling is an SNS topic we would build and run.
SES_PER_1K: Final = 0.10


def amazon_ses(volume: Volume) -> Bill:
    return (
        LineItem(
            f"pay as you go ({volume.total():,.0f} emails)", volume.total() / 1000 * SES_PER_1K
        ),
    )


# --- Twilio SendGrid ------------------------------------------------
# https://www.twilio.com/en-us/sendgrid/pricing. The permanent free plan became a 60-day trial in
# 2025, so there is no free rung to land on. Essentials has no overage — exceeding it means moving
# to Pro. Published volumes for Essentials vary between 50k and 100k depending on the page; the
# lower figure is used here, which cannot flatter it.
SENDGRID_PLANS: Final = (
    Plan("Essentials 50k", 19.95, 50_000, overage_per_1k=None),
    Plan("Pro 100k", 89.95, 100_000, overage_per_1k=None),
)


def sendgrid(volume: Volume) -> Bill:
    return plan_bill(SENDGRID_PLANS, volume)


PROVIDERS: Final[tuple[tuple[str, Callable[[Volume], Bill]], ...]] = (
    ("Resend", resend),
    ("Postmark", postmark),
    ("Amazon SES", amazon_ses),
    ("SendGrid", sendgrid),
)


# ------------------------------------------------------------------
# Output
# ------------------------------------------------------------------


def total(bill: Bill) -> float:
    return sum(item.dollars for item in bill)


def format_scenario(scenario: Scenario) -> str:
    volume = scenario.volume()
    lines = [scenario.name, "=" * len(scenario.name)]
    lines.append(f"  {volume.total():,.0f} emails/month, ~{volume.peak_day():,.0f} on the peak day")
    lines.extend(f"    {label:<44} {count:>8,.0f}" for label, count in volume.sources())
    for provider, estimate in PROVIDERS:
        bill = estimate(volume)
        lines.append(f"  {provider}: ${total(bill):,.2f}/month")
        lines.extend(f"    {item.label:<44} ${item.dollars:>7,.2f}" for item in bill)
    return "\n".join(lines)


def format_summary() -> str:
    width = max(len(scenario.name) for scenario in SCENARIOS)
    header = f"{'Scenario':<{width}}  {'Emails':>8}  " + "  ".join(
        f"{name:>11}" for name, _ in PROVIDERS
    )
    rows = [
        f"{scenario.name:<{width}}  {scenario.volume().total():>8,.0f}  "
        + "  ".join(f"${total(estimate(scenario.volume())):>10,.2f}" for _, estimate in PROVIDERS)
        for scenario in SCENARIOS
    ]
    return "\n".join([header, "-" * len(header), *rows])


def main() -> None:
    print(f"Monthly email estimates. Prices as of {PRICES_AS_OF}; volume figures are guesses.\n")
    print(format_summary())
    print()
    print("\n\n".join(format_scenario(scenario) for scenario in SCENARIOS))


if __name__ == "__main__":
    main()
