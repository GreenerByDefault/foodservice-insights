#!/usr/bin/env python3
"""Estimate the monthly bill for running the product, by vendor.

    uv run scripts/monthly_costs.py

Each vendor is the one we chose, on the plan we decided. The script has three parts:

1. **Scenarios** — the volume a month carries and how the app is deployed. `PLANNED` sets every
   input; every other scenario is a `replace()` of it naming only what differs. To model
   something new — two workers, three attempts each, more new clients — add one.
2. **One section per vendor** — its list price, snapshotted on `PRICES_AS_OF` with the page it
   came from, and the assumptions that turn a scenario into a bill. Prices drift; re-check before
   quoting one. Usage figures are guesses until production has run for a month, and each says
   what replaces it.
3. **Output** — one table, vendors down the side and scenarios across.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Final

from gbd_foodservice_insights.categorization.llm import DEFAULT_MODEL, cost_micro_usd

PRICES_AS_OF: Final = "2026-10-14"

# ------------------------------------------------------------------
# Scenarios
# ------------------------------------------------------------------


@dataclass(frozen=True)
class Scenario:
    name: str
    reports_per_month: int

    # Email
    users: int
    new_users_per_month: int
    new_orgs_per_month: int

    # OpenAI
    products_per_report: int  # distinct products in one upload
    cache_miss_rate: float  # share of those with no verified cache row

    # DigitalOcean
    web_instances: int
    worker_instances: int
    attempts_per_worker: int  # `maxConcurrentAttempts`: Python children a worker runs at once


PLANNED: Final = Scenario(
    "Planned",
    reports_per_month=500,
    users=40,
    new_users_per_month=8,
    new_orgs_per_month=3,
    # A guess; GBD's data scientists know the real spread across clients' exports.
    products_per_report=1_000,
    # Mostly returning clients, whose products a reviewer has already verified. A product the LLM
    # categorizes is only suggested to the cache, so it misses again on every upload until someone
    # verifies it.
    cache_miss_rate=0.1,
    # What .do/web.yaml and .do/worker.yaml run today; not yet tuned. More instances than
    # packages/db/src/budget.ts holds need its test to still pass on Supabase's Small.
    web_instances=1,
    worker_instances=1,
    attempts_per_worker=3,
)

SCENARIOS: Final = (
    replace(
        PLANNED,
        name="Launch",
        reports_per_month=100,
        users=10,
        new_users_per_month=3,
        new_orgs_per_month=2,
    ),
    PLANNED,
    replace(PLANNED, name="2 workers", worker_instances=2),
    # Every upload from a client whose products the cache has not seen.
    replace(PLANNED, name="New clients", cache_miss_rate=0.3),
    replace(
        PLANNED,
        name="Growth",
        reports_per_month=2_000,
        users=150,
        new_users_per_month=25,
        new_orgs_per_month=6,
    ),
)


@dataclass(frozen=True)
class LineItem:
    label: str
    dollars: float


Bill = tuple[LineItem, ...]


# ------------------------------------------------------------------
# Supabase: database, auth, and blob store
# ------------------------------------------------------------------
# https://supabase.com/pricing and https://supabase.com/docs/guides/platform/compute-and-disk.
# Pro's compute credit applies to any size, so Small costs its difference over Micro. Small is set
# by connections, not load: packages/db/src/budget.ts sums every pool against `max_connections`,
# and Micro's 60 cannot hold it. The IPv4 add-on is what lets DigitalOcean, which has no outbound
# IPv6, reach the direct host (ARCHITECTURE.md § Supabase).
#
# No usage lines, because Pro's quotas sit far above our usage. Storage only grows, since deleting
# a report keeps its files (REQUIREMENTS.md § Data deletion), but at a few MB a report the planned
# volume takes years to fill 100 GB, and past it storage is $0.0213/GB. The database holds rows
# and ~3 MB of categorization cache against 8 GB of disk; egress is a few GB against 250 GB; and
# users are in the hundreds against 100,000 monthly active.
SUPABASE_PRO: Final = 25.0
SUPABASE_SMALL_COMPUTE: Final = 15.0
SUPABASE_COMPUTE_CREDIT: Final = 10.0
SUPABASE_IPV4: Final = 4.0


def supabase(_: Scenario) -> Bill:
    return (
        LineItem("Pro plan", SUPABASE_PRO),
        LineItem("Small compute", SUPABASE_SMALL_COMPUTE),
        LineItem("compute credit included in Pro", -SUPABASE_COMPUTE_CREDIT),
        LineItem("IPv4 add-on", SUPABASE_IPV4),
    )


# ------------------------------------------------------------------
# DigitalOcean App Platform: web and worker
# ------------------------------------------------------------------
# https://www.digitalocean.com/pricing/app-platform. Billed by the instance size allocated, busy or
# not, so only the size and the count move the bill. Shared CPU throughout: the dedicated tiers
# start at $29 and buy nothing an IO-bound worker needs.


@dataclass(frozen=True)
class InstanceTier:
    name: str
    memory_gb: float
    dollars_per_month: float
    scalable: bool = True  # the two cheapest tiers are pinned to a single instance


DIGITALOCEAN_TIERS: Final = (
    InstanceTier("apps-s-1vcpu-0.5gb", 0.5, 5.0, scalable=False),
    InstanceTier("apps-s-1vcpu-1gb-fixed", 1.0, 10.0, scalable=False),
    InstanceTier("apps-s-1vcpu-1gb", 1.0, 12.0),
    InstanceTier("apps-s-1vcpu-2gb", 2.0, 25.0),
    InstanceTier("apps-s-2vcpu-4gb", 4.0, 50.0),
)

# Peak memory per process. Guesses until production's Insights tab measures them.
WEB_MEMORY_GB: Final = 0.3  # uploads are capped at 10MB, so a request never holds much
WORKER_PARENT_MEMORY_GB: Final = 0.15  # Node, idling between attempts
CHILD_MEMORY_GB: Final = 0.4  # one Python child per attempt

# A container that reaches its allocation is killed, taking its attempts with it.
MEMORY_HEADROOM: Final = 1.25

# Two egress costs left out on purpose:
#
# - Bandwidth. Each instance adds to a pooled allowance, 50 GiB on the smallest tier and 200 GiB
#   on a 2 GB one, and we send a few GB a month: inputs and results to Supabase Storage, OpenAI
#   requests of a few KB each, and pages to users. Forwarded logs do not count. Past the
#   allowance it is $0.02/GiB.
# - The dedicated egress IP add-on, $25 per app per month, and web and worker are separate apps.
#   It gives an app a fixed pair of IPv4 addresses, which only matters to a destination that
#   allowlists by IP, and none of ours does: OpenAI and Postmark authenticate by key, and
#   Supabase's network restrictions stay off, since migrations run from GitHub-hosted runners and
#   data scientists connect from their laptops. Nor does it help reach Supabase: App Platform has
#   no outbound IPv6 and the add-on is IPv4 only, which is what Supabase's IPv4 add-on fixes.


def smallest_tier(memory_gb: float, instances: int) -> InstanceTier:
    fitting = [
        tier
        for tier in DIGITALOCEAN_TIERS
        if tier.memory_gb >= memory_gb * MEMORY_HEADROOM and (tier.scalable or instances == 1)
    ]
    if not fitting:
        raise ValueError(f"No instance tier fits {memory_gb} GB x {instances}")
    return min(fitting, key=lambda tier: tier.dollars_per_month)


def digitalocean(scenario: Scenario) -> Bill:
    web = smallest_tier(WEB_MEMORY_GB, scenario.web_instances)
    worker_memory_gb = WORKER_PARENT_MEMORY_GB + scenario.attempts_per_worker * CHILD_MEMORY_GB
    worker = smallest_tier(worker_memory_gb, scenario.worker_instances)
    return (
        LineItem(f"web ({web.name})", web.dollars_per_month * scenario.web_instances),
        LineItem(f"workers ({worker.name})", worker.dollars_per_month * scenario.worker_instances),
    )


# ------------------------------------------------------------------
# Postmark: email
# ------------------------------------------------------------------
# https://postmarkapp.com/pricing. Basic, which keeps 45 days of sent mail to search. The $0
# Developer tier is a 100-email test allowance, not a plan to run on.
POSTMARK_BASIC: Final = 15.0
POSTMARK_BASIC_EMAILS: Final = 10_000
POSTMARK_OVERAGE_PER_1K: Final = 1.80

# Every sign-in sends a one-time passcode (REQUIREMENTS.md § Authentication mechanism), which
# Supabase Auth sends through Postmark's SMTP, so an active user costs email even in a month they
# never run a report. Sessions outlive a single visit, so this is sessions started, not visits.
LOGINS_PER_USER_PER_MONTH: Final = 4.0

# A code that arrives late, or lands in spam, makes the user ask for another. Supabase enforces a
# 60-second cooldown per address, so this is bounded by impatience rather than by a retry loop.
EXTRA_CODE_RATE: Final = 0.2

# One result email per report that reaches a terminal state. Canceled attempts get none
# (REQUIREMENTS.md § User email).
NOTIFICATIONS_PER_REPORT: Final = 1.0

# An invite, plus the occasional re-invite when the first is missed or expires.
EMAILS_PER_INVITE: Final = 1.3

# Organization created, organization deleted, user deleted, all to the one GBD address
# (REQUIREMENTS.md § GBD email notifications). Scaled off new organizations, since creation is the
# common one and deletions trail it.
GBD_NOTICES_PER_NEW_ORG: Final = 1.5


def emails_per_month(scenario: Scenario) -> float:
    return (
        scenario.users * LOGINS_PER_USER_PER_MONTH * (1 + EXTRA_CODE_RATE)
        + scenario.reports_per_month * NOTIFICATIONS_PER_REPORT
        + scenario.new_users_per_month * EMAILS_PER_INVITE
        + scenario.new_orgs_per_month * GBD_NOTICES_PER_NEW_ORG
    )


def postmark(scenario: Scenario) -> Bill:
    overage = emails_per_month(scenario) - POSTMARK_BASIC_EMAILS
    return (
        LineItem(f"Basic ({POSTMARK_BASIC_EMAILS:,} emails included)", POSTMARK_BASIC),
        LineItem(
            f"overage (${POSTMARK_OVERAGE_PER_1K:.2f} per 1,000)",
            max(0.0, overage) / 1000 * POSTMARK_OVERAGE_PER_1K,
        ),
    )


# ------------------------------------------------------------------
# OpenAI: categorization
# ------------------------------------------------------------------
# The model and its price come from the product's `categorization/llm.py`, so switching models
# there moves this estimate too.
#
# Only a product with no verified cache row reaches the LLM, so the scenario's
# `products_per_report` and `cache_miss_rate` drive this line. Nothing caps the misses before the
# calls: the one rejection, more than 80% of products coming back "No Matches Found"
# (`merge_categorizations`), comes after them. Every call is a fixed system prompt plus the
# product's name, with no batching, and a retried attempt reruns every call.

# `clean`, then `match` unless the cleaned name is already cached.
CALLS_PER_UNCACHED_PRODUCT: Final = 2
# Estimated from the prompts/ files at ~4 characters a token: ~1,000 for `clean`, ~1,150 for
# `match`, with the category list filled in.
INPUT_TOKENS_PER_CALL: Final = 1_050
OUTPUT_TOKENS_PER_CALL: Final = 10  # a name or a category, capped at `MAX_TOKENS` = 30
ATTEMPTS_PER_REPORT: Final = 1.1

# All input is priced uncached. OpenAI caches only prompts of at least 1,024 tokens, and both sit
# near that line; if both do cache, this line is up to ~70% lower.
#
# The ceiling: the worker kills an attempt at 20 minutes (`killAfterTotalRuntimeMs`), which at
# ~1 s a call across 3 threads is ~3,600 calls, or ~$1.60. So no report, across its
# `MAX_ANALYSIS_ATTEMPTS` = 5, costs more than ~$8.


def openai_calls_per_report(scenario: Scenario) -> float:
    uncached_products = scenario.products_per_report * scenario.cache_miss_rate
    return uncached_products * CALLS_PER_UNCACHED_PRODUCT * ATTEMPTS_PER_REPORT


def openai(scenario: Scenario) -> Bill:
    calls = round(scenario.reports_per_month * openai_calls_per_report(scenario))
    micro_usd = cost_micro_usd(
        DEFAULT_MODEL,
        input_tokens=calls * INPUT_TOKENS_PER_CALL,
        cached_input_tokens=0,
        output_tokens=calls * OUTPUT_TOKENS_PER_CALL,
    )
    return (LineItem(DEFAULT_MODEL, micro_usd / 1_000_000),)


# ------------------------------------------------------------------
# Free tiers: logs, dashboards, and the edge
# ------------------------------------------------------------------


# https://betterstack.com/pricing. Free keeps 3 GB of logs a month for 3 days, which is enough:
# the database keeps why each report failed for good, and logs add the detail. We send tens of MB
# a month. Its uptime monitors check every 3 minutes; 30-second checks need a paid plan.
def better_stack(_: Scenario) -> Bill:
    return (LineItem("Free (3 days of logs, 10 monitors)", 0.0),)


# https://grafana.com/pricing. Free covers 3 users, which is the team; a fourth needs Pro, a $19
# platform fee plus per-user pricing from $8. Its dashboards query the database in place, and the
# Supabase metrics scrape is ~200 series of the free 10,000.
def grafana_cloud(_: Scenario) -> Bill:
    return (LineItem("Free (3 users)", 0.0),)


VENDORS: Final[tuple[tuple[str, Callable[[Scenario], Bill]], ...]] = (
    ("Supabase", supabase),
    ("DigitalOcean", digitalocean),
    ("Postmark", postmark),
    ("OpenAI", openai),
    ("Better Stack", better_stack),
    ("Grafana Cloud", grafana_cloud),
)


# ------------------------------------------------------------------
# Output
# ------------------------------------------------------------------


def total(bill: Bill) -> float:
    return sum(item.dollars for item in bill)


def money(dollars: float) -> str:
    return f"-${-dollars:,.0f}" if dollars < 0 else f"${dollars:,.0f}"


# A row's label and one cell per scenario; None draws a rule.
Row = tuple[str, tuple[str, ...]] | None


def scenario_row(label: str, cell: Callable[[Scenario], str]) -> Row:
    return (label, tuple(cell(scenario) for scenario in SCENARIOS))


def vendor_rows(name: str, estimate: Callable[[Scenario], Bill]) -> list[Row]:
    """The vendor's total, then each line item, matched across scenarios by label. A scenario
    whose bill lacks a line, such as a different instance tier, shows a dash."""
    bills = [estimate(scenario) for scenario in SCENARIOS]
    labels = dict.fromkeys(item.label for bill in bills for item in bill)

    def cell(bill: Bill, label: str) -> str:
        matches = [item.dollars for item in bill if item.label == label]
        return money(sum(matches)) if matches else "-"

    vendor_total: Row = (name, tuple(money(total(bill)) for bill in bills))
    items: list[Row] = [
        (f"  {label}", tuple(cell(bill, label) for bill in bills)) for label in labels
    ]
    return [vendor_total, *items]


def format_table(rows: Sequence[Row]) -> str:
    width = max(len(row[0]) for row in rows if row is not None) + 2
    cell_width = 12
    rule = "-" * (width + cell_width * len(SCENARIOS))
    return "\n".join(
        rule
        if row is None
        else (f"{row[0]:<{width}}" + "".join(f"{cell:>{cell_width}}" for cell in row[1])).rstrip()
        for row in rows
    )


def main() -> None:
    inputs = [
        scenario_row("", lambda s: s.name),
        scenario_row("reports a month", lambda s: f"{s.reports_per_month:,}"),
        scenario_row(
            "workers × attempts each", lambda s: f"{s.worker_instances} × {s.attempts_per_worker}"
        ),
        scenario_row("products not yet cached", lambda s: f"{s.cache_miss_rate:.0%}"),
    ]
    vendors = [row for name, estimate in VENDORS for row in vendor_rows(name, estimate)]
    totals = scenario_row(
        "Total", lambda s: money(sum(total(estimate(s)) for _, estimate in VENDORS))
    )
    usage = [
        scenario_row("emails a month", lambda s: f"{emails_per_month(s):,.0f}"),
        scenario_row("OpenAI calls a report", lambda s: f"{openai_calls_per_report(s):,.0f}"),
        scenario_row(
            "OpenAI per report", lambda s: f"${total(openai(s)) / s.reports_per_month:.2f}"
        ),
    ]
    print(f"Monthly cost estimate. Prices as of {PRICES_AS_OF}; usage figures are guesses.\n")
    print(format_table([*inputs, None, *vendors, None, totals, None, *usage]))


if __name__ == "__main__":
    main()
