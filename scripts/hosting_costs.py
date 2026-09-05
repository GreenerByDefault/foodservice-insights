#!/usr/bin/env python3
"""Estimate the monthly bill for hosting web + worker on Railway, Render, and DigitalOcean.

    uv run scripts/hosting_costs.py

Three things drive the estimate, and each lives in its own section below so it can be changed
on its own:

1. **Container sizes** — what each service needs allocated, and what it actually uses on
   average. Every number is a guess until production has run for a month; replace them with
   figures from the provider's metrics then.
2. **Scenarios** — how many of each service, and how much work flows through them.
3. **Prices** — each provider's public list price, snapshotted on `PRICES_AS_OF` with the page
   it came from. They drift; re-check before quoting one.

The bill splits along one line: Railway meters what a container *uses* (vCPU-seconds and
GB-seconds), while Render and DigitalOcean charge for the instance size you *allocate*, busy
or not. So, the `avg_*` assumptions only move Railway's number, and the allocation assumptions
only move the other two.

Left out on purpose because they are the same whichever host we pick: Supabase, Cloudflare,
the email provider, and AI API spend.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Final

PRICES_AS_OF: Final = "2026-09-05"

# What every provider bills a full month as: 8760 hours / 12.
HOURS_PER_MONTH: Final = 730

# ------------------------------------------------------------------
# Container sizes
# ------------------------------------------------------------------

# A single analysis attempt averages ~5 minutes (REQUIREMENTS.md § Performance).
MINUTES_PER_ATTEMPT: Final = 5

# The worker parent is a Node process that idles between attempts; each attempt adds one Python
# child, capped at 3 by apps/worker/src/config.ts. Allocation has to fit the parent plus three
# busy children at once; the average is far lower because most of the month no attempt is
# running. If the parent plus three children measure under 1 GB in production, both Render and
# DigitalOcean get cheaper — see the instance tables below.
WORKER_ALLOCATED_VCPU: Final = 1.0
WORKER_ALLOCATED_MEMORY_GB: Final = 2.0
WORKER_IDLE_VCPU: Final = 0.02
WORKER_IDLE_MEMORY_GB: Final = 0.15
CHILD_VCPU: Final = 0.25  # IO-bound: it waits on AI APIs (ARCHITECTURE.md § Worker)
CHILD_MEMORY_GB: Final = 0.4

# SvelteKit under adapter-node. Uploads are capped at 10MB by
# apps/web/src/lib/reports/upload-limit.js, so a request never holds much in memory.
WEB_ALLOCATED_VCPU: Final = 0.5
WEB_ALLOCATED_MEMORY_GB: Final = 0.5
WEB_AVG_VCPU: Final = 0.05
WEB_AVG_MEMORY_GB: Final = 0.2

# Outbound traffic from the host: HTML/JSON to browsers (Cloudflare fronts it), result files
# and inputs to and from Supabase Storage. Small either way; here so the line item exists.
EGRESS_GB_PER_REPORT: Final = 0.02
EGRESS_GB_BASELINE: Final = 2.0


@dataclass(frozen=True)
class Container:
    """One running copy of a service.

    `vcpu`/`memory_gb` is what must be allocated; `avg_*` is what it uses averaged over the month.
    """

    vcpu: float
    memory_gb: float
    avg_vcpu: float
    avg_memory_gb: float


def worker_container(*, reports_per_month: int, replicas: int) -> Container:
    """A worker replica's average load, given the work spread evenly across the replicas."""
    child_hours = reports_per_month * MINUTES_PER_ATTEMPT / 60
    avg_children_per_replica = child_hours / HOURS_PER_MONTH / replicas
    return Container(
        vcpu=WORKER_ALLOCATED_VCPU,
        memory_gb=WORKER_ALLOCATED_MEMORY_GB,
        avg_vcpu=WORKER_IDLE_VCPU + avg_children_per_replica * CHILD_VCPU,
        avg_memory_gb=WORKER_IDLE_MEMORY_GB + avg_children_per_replica * CHILD_MEMORY_GB,
    )


WEB_CONTAINER: Final = Container(
    vcpu=WEB_ALLOCATED_VCPU,
    memory_gb=WEB_ALLOCATED_MEMORY_GB,
    avg_vcpu=WEB_AVG_VCPU,
    avg_memory_gb=WEB_AVG_MEMORY_GB,
)


@dataclass(frozen=True)
class Service:
    label: str
    container: Container
    replicas: int


@dataclass(frozen=True)
class Environment:
    """One deployed copy of the system, e.g. production or staging."""

    name: str
    services: tuple[Service, ...]
    egress_gb: float


def environment(
    name: str, *, reports_per_month: int, web_replicas: int, worker_replicas: int
) -> Environment:
    worker = worker_container(reports_per_month=reports_per_month, replicas=worker_replicas)
    return Environment(
        name=name,
        services=(
            Service("web", WEB_CONTAINER, web_replicas),
            Service("worker", worker, worker_replicas),
        ),
        egress_gb=EGRESS_GB_BASELINE + reports_per_month * EGRESS_GB_PER_REPORT,
    )


@dataclass(frozen=True)
class Scenario:
    name: str
    environments: tuple[Environment, ...]
    # People who need their own dashboard login. Only matters where a plan is seat-limited.
    seats: int

    def egress_gb(self) -> float:
        return sum(env.egress_gb for env in self.environments)


# ------------------------------------------------------------------
# Scenarios
# ------------------------------------------------------------------

SCENARIOS: Final = (
    Scenario(
        "Launch: 1 web, 1 worker, ~100 reports/month",
        environments=(
            environment("prod", reports_per_month=100, web_replicas=1, worker_replicas=1),
        ),
        seats=2,
    ),
    Scenario(
        "Planned: 1 web, 2 workers, ~500 reports/month",
        environments=(
            environment("prod", reports_per_month=500, web_replicas=1, worker_replicas=2),
        ),
        seats=2,
    ),
    Scenario(
        "Planned + staging",
        environments=(
            environment("prod", reports_per_month=500, web_replicas=1, worker_replicas=2),
            environment("staging", reports_per_month=20, web_replicas=1, worker_replicas=1),
        ),
        seats=2,
    ),
    Scenario(
        "Growth: 2 web, 3 workers, ~2,000 reports/month, + staging",
        environments=(
            environment("prod", reports_per_month=2_000, web_replicas=2, worker_replicas=3),
            environment("staging", reports_per_month=20, web_replicas=1, worker_replicas=1),
        ),
        seats=3,
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
class InstanceType:
    """A fixed-size tier, for providers that charge by allocation."""

    name: str
    vcpu: float
    memory_gb: float
    dollars_per_month: float
    # Some cheap tiers are pinned to a single instance, so they cannot serve a scaled service.
    max_instances: int | None = None
    # Outbound bandwidth this instance adds to the account's pooled allowance.
    included_egress_gb: float = 0.0


def smallest_fitting(tiers: Iterable[InstanceType], service: Service) -> InstanceType:
    needs = service.container
    fitting = [
        t
        for t in tiers
        if t.vcpu >= needs.vcpu
        and t.memory_gb >= needs.memory_gb
        and (t.max_instances is None or t.max_instances >= service.replicas)
    ]
    if not fitting:
        raise ValueError(f"No instance type fits {service.label} x {service.replicas}")
    return min(fitting, key=lambda t: t.dollars_per_month)


def allocated_instances(
    env: Environment, tiers: Iterable[InstanceType]
) -> tuple[tuple[Service, InstanceType], ...]:
    tiers = tuple(tiers)
    return tuple((service, smallest_fitting(tiers, service)) for service in env.services)


def instance_line(env: Environment, service: Service, tier: InstanceType) -> LineItem:
    return LineItem(
        f"{env.name} {service.label} x {service.replicas} ({tier.name})",
        tier.dollars_per_month * service.replicas,
    )


def overage(used: float, included: float, dollars_per_unit: float) -> float:
    return max(0.0, used - included) * dollars_per_unit


# --- Railway --------------------------------------------------------
# https://railway.com/pricing and https://docs.railway.com/pricing/plans. Pro rather than Hobby:
# the CPU/memory alerts ARCHITECTURE.md § Failure modes relies on ("Monitors") are Pro-only, as
# is 30-day log retention. Pro is a flat fee per workspace with unlimited seats, and the fee
# comes back as a usage credit, so the bill is `max(fee, usage)` plus egress.
RAILWAY_PRO_FEE: Final = 20.0
RAILWAY_PRO_USAGE_CREDIT: Final = 20.0
RAILWAY_VCPU_SECOND: Final = 0.00000772  # ≈ $20 per vCPU-month, metered on actual use
RAILWAY_GB_SECOND: Final = 0.00000386  # ≈ $10 per GB-month, metered on actual use
RAILWAY_EGRESS_GB: Final = 0.05
SECONDS_PER_HOUR: Final = 3600


def railway(scenario: Scenario) -> Bill:
    items = [LineItem("Pro plan (flat, unlimited seats)", RAILWAY_PRO_FEE)]
    for env in scenario.environments:
        for service in env.services:
            per_second = (
                service.container.avg_vcpu * RAILWAY_VCPU_SECOND
                + service.container.avg_memory_gb * RAILWAY_GB_SECOND
            )
            monthly = per_second * SECONDS_PER_HOUR * HOURS_PER_MONTH * service.replicas
            items.append(
                LineItem(f"{env.name} {service.label} x {service.replicas} (metered)", monthly)
            )
    items.append(LineItem("egress", scenario.egress_gb() * RAILWAY_EGRESS_GB))
    usage = sum(item.dollars for item in items[1:])
    items.append(LineItem("usage credit included in Pro", -min(usage, RAILWAY_PRO_USAGE_CREDIT)))
    return tuple(items)


# --- Render ---------------------------------------------------------
# https://render.com/pricing and https://render.com/docs/compute-plans, after the 2026-04-23 plan
# change. Hobby is free but has one seat; Pro is a flat fee per workspace with unlimited seats.
# Background workers cost the same as web services of the same size, and the jump from
# 0.5 CPU / 512 MB to 1 CPU / 2 GB has no step in between.
RENDER_PRO_FEE: Final = 25.0
RENDER_HOBBY_SEATS: Final = 1
RENDER_INSTANCE_TYPES: Final = (
    InstanceType("0.5c-512mb", 0.5, 0.5, 7.0),
    InstanceType("1c-2g", 1.0, 2.0, 25.0),
    InstanceType("2c-4g", 2.0, 4.0, 85.0),
    InstanceType("2c-8g", 2.0, 8.0, 135.0),
    InstanceType("4c-8g", 4.0, 8.0, 175.0),
)
RENDER_EGRESS_GB: Final = 0.15
RENDER_EGRESS_INCLUDED_GB: Final = {"Hobby": 5.0, "Pro": 25.0}


def render(scenario: Scenario) -> Bill:
    plan = "Hobby" if scenario.seats <= RENDER_HOBBY_SEATS else "Pro"
    items = [LineItem(f"{plan} plan (flat)", RENDER_PRO_FEE if plan == "Pro" else 0.0)]
    for env in scenario.environments:
        items.extend(
            instance_line(env, service, tier)
            for service, tier in allocated_instances(env, RENDER_INSTANCE_TYPES)
        )
    items.append(
        LineItem(
            "egress",
            overage(scenario.egress_gb(), RENDER_EGRESS_INCLUDED_GB[plan], RENDER_EGRESS_GB),
        )
    )
    return tuple(items)


# --- DigitalOcean App Platform --------------------------------------
# https://docs.digitalocean.com/products/app-platform/details/pricing/ and
# https://www.digitalocean.com/pricing/app-platform. No seat fee. Shared-CPU tiers only; the
# dedicated-CPU tiers start at $29 and are not needed for an IO-bound worker. The two cheapest
# tiers are pinned to one instance. Bandwidth is pooled across the account per instance.
DIGITALOCEAN_INSTANCE_TYPES: Final = (
    InstanceType("apps-s-1vcpu-0.5gb", 1.0, 0.5, 5.0, max_instances=1, included_egress_gb=50),
    InstanceType("apps-s-1vcpu-1gb-fixed", 1.0, 1.0, 10.0, max_instances=1, included_egress_gb=100),
    InstanceType("apps-s-1vcpu-1gb", 1.0, 1.0, 12.0, included_egress_gb=150),
    InstanceType("apps-s-1vcpu-2gb", 1.0, 2.0, 25.0, included_egress_gb=200),
    InstanceType("apps-s-2vcpu-4gb", 2.0, 4.0, 50.0, included_egress_gb=250),
)
DIGITALOCEAN_EGRESS_GB: Final = 0.02


def digitalocean(scenario: Scenario) -> Bill:
    items: list[LineItem] = []
    included_egress = 0.0
    for env in scenario.environments:
        for service, tier in allocated_instances(env, DIGITALOCEAN_INSTANCE_TYPES):
            items.append(instance_line(env, service, tier))
            included_egress += tier.included_egress_gb * service.replicas
    items.append(
        LineItem("egress", overage(scenario.egress_gb(), included_egress, DIGITALOCEAN_EGRESS_GB))
    )
    return tuple(items)


PROVIDERS: Final[tuple[tuple[str, Callable[[Scenario], Bill]], ...]] = (
    ("Railway", railway),
    ("Render", render),
    ("DigitalOcean", digitalocean),
)


# ------------------------------------------------------------------
# Output
# ------------------------------------------------------------------


def total(bill: Bill) -> float:
    return sum(item.dollars for item in bill)


def format_scenario(scenario: Scenario) -> str:
    lines = [scenario.name, "=" * len(scenario.name)]
    for provider, estimate in PROVIDERS:
        bill = estimate(scenario)
        lines.append(f"  {provider}: ${total(bill):,.0f}/month")
        lines.extend(f"    {item.label:<48} ${item.dollars:>8,.2f}" for item in bill)
    return "\n".join(lines)


def format_summary() -> str:
    width = max(len(s.name) for s in SCENARIOS)
    header = f"{'Scenario':<{width}}  " + "  ".join(f"{name:>13}" for name, _ in PROVIDERS)
    rows = [
        f"{scenario.name:<{width}}  "
        + "  ".join(f"${total(estimate(scenario)):>12,.0f}" for _, estimate in PROVIDERS)
        for scenario in SCENARIOS
    ]
    return "\n".join([header, "-" * len(header), *rows])


def main() -> None:
    print(f"Monthly hosting estimates. Prices as of {PRICES_AS_OF}; usage figures are guesses.\n")
    print(format_summary())
    print()
    print("\n\n".join(format_scenario(s) for s in SCENARIOS))


if __name__ == "__main__":
    main()
