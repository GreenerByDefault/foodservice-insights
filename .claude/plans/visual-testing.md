# Visual testing

Adding two complementary checks to the web app: a small set of layout invariants asserted
directly, and Playwright pixel snapshots committed to Git. The snapshots double as a gallery —
images a client can be shown and an agent can read — which is as much the point as regression
detection.

## Context

The web app is early and most routes are not yet built, but nearly all of it is written by an
LLM, so "does this actually look right" is a gap our current tests don't cover. Component tests
in `apps/web/vite.config.ts` run in real Chromium but test frontend logic, not appearance. The
e2e suite in `apps/web/e2e/` asserts behaviour.

Several states worth looking at exist only when the database is shaped a certain way — the
report view's terminal states most of all. `apps/web/playwright.config.ts` already truncates,
migrates, seeds, and boots the real `adapter-node` build before the suite, so the machinery for
putting the database in a known state is present; what's missing is *deterministic* fixtures on
top of it.

CI (`.github/workflows/ci.yml`) runs `ubuntu-latest` only. Developers are on macOS. This is the
constraint that shapes the whole design, because font rasterization differs between the two and
a snapshot taken on one platform will not match the other.

The layout-invariants half already exists: `apps/web/e2e/lib/layout.ts` exports
`expectNoHorizontalOverflow(page)`, and `apps/web/e2e/layout.e2e.ts` runs it at the widths in
`apps/web/e2e/lib/viewports.ts` (`mobile`/`tablet`/`desktop`) against every route reachable with
today's seed data. What's left is the pixel-snapshot half below.

## Decisions

**Accepted: pixel snapshots via `toHaveScreenshot`, committed to Git.** Committing them buys
three things at once — GitHub renders an image swipe in the PR so a reviewer sees the visual
change whether or not they thought about snapshots; an agent can `Read` the PNGs directly to
look at the UI; and the folder is a gallery that can be shown to a client. Do **not** mark the
screenshot directory `linguist-generated=true` in `.gitattributes`; that collapses the diff and
destroys the main reason for committing them.

**Accepted: CI verifies, never pushes.** CI regenerates and fails on a dirty tree. This is a
stronger guarantee against stale committed images than a bot push, which would leave the merge
gated on the pre-push SHA. It also sidesteps two problems entirely: no workflow recursion, and
no write permissions — important because the repo is public and a fork PR gets a read-only
token and no secrets, so a push-based design could never have worked for outside contributors.
Never reach for `pull_request_target` here.

**Accepted: the container is the cross-platform contract.** Both CI and a developer's Mac
capture through a browser running in `mcr.microsoft.com/playwright:v1.62.1-noble`. Same
Chromium, same fontconfig, same freetype, so output matches by construction. Docker is already
a prerequisite for the Supabase stacks, so this adds no new dependency.

**Accepted: only the browser goes in the container, not the test run.** Three processes are
involved, and only the third is containerized:

| Process | Where | Needs our `node_modules` |
| --- | --- | --- |
| App server — the `adapter-node` build on 4173, started by Playwright's `webServer` | Host | Yes, and has them |
| Test process — `playwright test` | Host | Yes, and has them |
| Browser server — `playwright run-server` | Container | No |

The browser server is Chromium plus a websocket wrapper. The image ships its own Playwright and
Chromium at a system path, so we mount nothing and install nothing into it: it takes commands
over the socket, loads the app over HTTP from the host, and returns screenshot bytes that the
*test process* writes to the repo. That's why nothing about our toolchain enters the image, and
why a pnpm workspace with native binaries and compiled `dist/` packages is a non-issue — none
of it is ever visible to the container.

Only the screenshot project pays the container cost; vitest, the component tests, and the
existing e2e tests stay fully native and fast.

**Accepted: `maxDiffPixels: 0`.** Any tolerance lets a small real change pass without rewriting
the PNG, so the committed image drifts from what the app renders — exactly the staleness we're
trying to prevent. With an identical container on both sides, exact equality should hold.

**Accepted: assert only the invariants a screenshot cannot show.** This is the rule that keeps
the direct-assertion suite small and fast, and it answers where the two techniques overlap. A
screenshot catches anything *visible* — clipping, overlap, spacing, broken layout — and does it
better than a property assertion, because a human or an agent looks at the image. What a
screenshot cannot show is content that is silently cut off, or a defect at a viewport width we
don't capture. So: assert horizontal overflow across several widths, and let the snapshot cover
everything visible. Resist growing this suite; every check added here is a check that must run
on every route forever.

**Considered, not done: multiple snapshot viewports.** Each additional width multiplies the
committed bytes. The multi-width overflow assertion covers the cheap part of responsive
breakage without paying for more PNGs. Revisit if mobile layout becomes a real product concern.

**Considered, not done: Git LFS.** A curated set is a few MB per full regeneration; LFS adds
setup friction and bandwidth quotas for a problem we don't have yet. Revisit if the set grows
past ~50 images or history bloat becomes visible.

**Accepted: the pinned browser image is the only thing that must match; the screenshot job
runs on arm64, every other job stays x86.** See `## Where things run` below for the full
picture. The short version: nothing about the app server's platform reaches a pixel, so it is
free to differ — and already does, since a developer's app server runs on macOS and CI's runs
on Linux. Rasterization is decided entirely by the browser, which is pinned to one image tag at
one `--platform` everywhere. `ubuntu-24.04-arm` is chosen for the screenshot job (free for
public repos) purely so that pinned arm64 browser runs natively rather than under QEMU.

Two consequences to implement deliberately:

- **The wrapper pins `--platform linux/arm64`, always.** Architecture must be a property of the
  invocation, not of whoever's laptop it is, or an x86 Linux developer or fork contributor
  silently produces amd64 pixels and a red build. They get an emulated arm64 browser instead:
  slow, but correct.
- **The screenshot job is not a substitute for the x86 e2e job.** It builds and runs the server
  on arm64, which is fine because it is not validating server behaviour — but it means the
  behavioural suite must stay on `ubuntu-latest`, since that is the one mirroring production.

**Considered, not done: pinning the browser to amd64 instead.** That would make CI native x86
and uniform, at the cost of emulating on every developer's Mac — moving the emulation penalty
from a batch job onto the interactive regeneration loop, which is the wrong place for it.

**Considered, not done: running the arm64 browser under QEMU on `ubuntu-latest`.** Avoids a
second runner type, but pays emulated rendering on every PR, and a QEMU-emulated Chromium is
exactly where subtle rasterization differences would be most plausible.

---

## Where things run

### Which browser runs where

Two Chromiums exist in this repo, and which one a test gets is decided by its project, not by
its environment:

- **Every screenshot is captured through the official image** —
  `mcr.microsoft.com/playwright:v1.62.1-noble`, always at `--platform linux/arm64`. Local, CI,
  a fork contributor's laptop: no exceptions, no environment where a screenshot comes from
  anything else. A PNG produced by any other browser is wrong by definition, because the image
  *is* the definition of correct output.
- **No other test uses the image.** The behavioural e2e suite, the vitest component tests, and
  anything run with `--headed` use the host Chromium that
  `.github/actions/playwright-browsers` and `playwright install` provide. They test behaviour,
  gain nothing from pinned rasterization, and would only pay a container hop and lose native
  debugging.

Both Chromiums must be Playwright 1.62.1: the host one via the `playwright` catalog pin in
`pnpm-workspace.yaml`, the container one via the image tag. See the lockstep note in PR 1.

Everything else in the stack is free to vary, and does.

| | Local (Apple Silicon) | CI — `screenshots` job | CI — `test:e2e` job |
| --- | --- | --- | --- |
| Runner / host | macOS arm64 | `ubuntu-24.04-arm` | `ubuntu-latest` (x86) |
| App server (`adapter-node`, :4173) | Host, macOS arm64 | Host, Linux arm64 | Host, Linux x86 |
| Supabase stack | Host Docker | Host Docker, arm64 | Host Docker, x86 |
| Test process (`playwright test`) | Host | Host | Host |
| Browser | Container, Linux arm64, **native** | Container, Linux arm64, **native** | Host Chromium (no container) |
| Runs | both projects | `--project=screenshots` only | `--project=e2e` only |

Reading this table is the fastest way to answer "does X have to match?" — the answer is no for
every row except the browser. The app server only emits HTML, CSS, and JSON; it cannot
influence how glyphs are rasterized. That is why a macOS app server and a Linux app server
produce byte-identical screenshots, and why we are free to put the screenshot job on whichever
runner makes the pinned browser fastest.

The x86 row is the one that carries a real constraint, and it is a product constraint rather
than a visual one: production is x86, so the job that exercises server behaviour has to be too.
That job never touches the container.

**Verify in PR 1, before anything is built on top of it:** that the whole e2e setup — the
Supabase CLI stack, the app build, `migrate`, `seed` — comes up cleanly on the arm runner. Its
images support arm64 and the build output is plain JS, but a native dependency without an arm
prebuild would surface here, and it is much cheaper to find now than in PR 2.

---

## PR 1 — Containerized browser, one screenshot

The risky PR. Keep it to a single image so the cross-platform question is answered before any
investment in fixtures.

- Split `apps/web/playwright.config.ts` into two projects: `e2e` (`**/*.e2e.ts`, host Chromium,
  unchanged behaviour) and `screenshots` (`**/*.screenshot.ts`, `use.connectOptions.wsEndpoint`
  pointing at the container). The project boundary is what decides which browser a test gets,
  so the `testMatch` patterns must not overlap — a screenshot picked up by the `e2e` project
  would be captured on host Chromium.
- Set `snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}'` — this drops Playwright's
  platform and browser suffixes, so there is exactly one canonical file per shot and a stray
  `-darwin` PNG cannot land.
- Set `maxDiffPixels: 0`, `animations: 'disabled'`, `caret: 'hide'`, one viewport at 1280 with
  `deviceScaleFactor: 1`.
- **Make a non-container capture impossible.** If `connectOptions.wsEndpoint` is unset,
  Playwright silently launches host Chromium — which on a Mac writes macOS pixels into
  `__screenshots__/` and looks like it worked. The screenshots project must fail loudly on a
  missing endpoint rather than falling back. This is the guard behind "every screenshot comes
  from the official image"; without it that rule is a convention, not an invariant.
- Container lifecycle via `globalSetup`, so `pnpm test` just works; no-op when the screenshots
  project isn't selected. Run it with `--platform linux/arm64` and
  `--add-host=host.docker.internal:host-gateway`, so `http://host.docker.internal:4173` is the
  `baseURL` override on both macOS and Linux — same URL and same architecture everywhere, no
  branching.
- CI: a **separate `screenshots` job on `ubuntu-24.04-arm`**, running only the screenshots
  project. Leave the existing `test:e2e` job on `ubuntu-latest` running only the `e2e` project
  — that one has to stay x86 because it exercises the server. Both need the same build and
  database setup; that duplication is the accepted cost of the split.
- Confirm the Supabase CLI stack starts on the arm runner before building anything on top of
  it.
- Add `pnpm --filter @gbd/web run screenshots:update`, wrapping the container plus
  `--update-snapshots`. This is the command humans and agents run after an intentional UI
  change, so it needs to be documented in `apps/web/e2e/README.md`; Playwright's own failure
  text will name the bare `playwright` command instead, which is the one discoverability hole.
- In the `screenshots` job: `updateSnapshots: 'none'` under `CI`, so a missing or differing
  snapshot is a hard failure rather than a silent write, plus an `if: failure()` step that
  regenerates and uploads the PNGs as an artifact and annotates with the update command. A fork
  contributor's path is: red check, download artifact, commit. (`git diff --exit-code` was the
  original design; with `updateSnapshots: 'none'` nothing is ever written to the committed path,
  so the diff could never fail and the check would be dead.)
- Exactness needs `threshold: 0` *and* `maxDiffPixels: 0`. `maxDiffPixels: 0` alone still lets
  every pixel drift by up to the default `threshold` of 0.2.
- Run PNGs through `oxipng` in the update script.
- One screenshot: the 404 page at `/no-such-page`. Renders no database content, so a failure
  here is unambiguously the container plumbing. (Not `/sign-in`: the placeholder `identifyUser`
  resolves every request to the seeded user, so that route always redirects to `/orgs`. It
  becomes reachable, and worth capturing, once real auth lands.)

**Version lockstep is load-bearing.** `connect()` requires the client and browser server to be
the same Playwright version. The image tag must track `playwright: 1.62.1` in
`pnpm-workspace.yaml`'s catalog, and the failure mode is a confusing connection error a long
way from the cause — comment it at both sites.

---

## PR 2 — Deterministic fixtures

The substantive work, and the part most likely to sink the whole thing if done casually. Every
`created_at DEFAULT now()` that surfaces in the UI as a date or a relative time makes the tree
dirty on every run, which means a permanently red build and a feature that gets ripped out
within a week.

`packages/db/src/seed.ts` writes no timestamps today, which is lucky, but report fixtures will.
Fixtures must write explicit fixed timestamps rather than relying on column defaults. Anything
genuinely unpinnable gets `mask: [locator]` on the screenshot.

Build a fixture layer in `apps/web/e2e/fixtures/` producing named database states, then
screenshot the report view in each:
queued, running, succeeded, failed, canceled, rate-limited, plus an organization with no
reports. Reuse the state definitions that `load-report.test.ts` already exercises so the two
stay in agreement about what a state means.

Split into two PRs if the fixture harness plus one state is already large; the remaining states
are then mechanical.

**Tests:** the fixtures are test infrastructure, so the screenshots are their test. Assert that
each fixture produces the report state it claims, so a fixture that silently degrades to
"queued" doesn't quietly screenshot the wrong thing.

---

## PR 3 — Curate, and fold the invariants in

- Extend snapshots to the remaining states worth capturing. **Curate.** Screenshotting every
  route in every state is where this gets expensive in both CI minutes and permanent Git bytes.
  Capture what carries real visual risk — the report terminal states, empty states, error pages
  — not the full route table.
- Call `expectNoHorizontalOverflow` from inside the screenshot page visits rather than from a
  separate `layout.e2e.ts` pass, so each state costs one navigation instead of two. Keep the
  standalone pass only for routes that have no screenshot.
- Re-read the `layout.e2e.ts` assertions against what the snapshots now cover and delete
  anything redundant. The rule from `## Decisions` is the test: if a violation would be visible
  in a committed PNG, the assertion is not earning its runtime.

---

## PR 4 — Contact sheet (optional)

A generated `index.html` laying the PNGs out as a browsable sheet, for showing a client without
handing them a GitHub folder. Skip unless someone actually asks; browsing the directory on
GitHub may be enough.

---

## Verification

`pnpm lint && pnpm check && pnpm test` from the repo root, per `AGENTS.md`.

Beyond that, two things the test suite cannot tell you:

- **The cross-platform claim, at PR 1.** Generate the snapshot on an Apple Silicon Mac, push,
  and confirm the arm64 CI job's `git diff --exit-code` passes. This must be proven on one
  image before PR 2 starts. If it fails, check first that both sides really ran the same image
  tag at the same `--platform`.
- **Determinism, at PR 2.** Run the screenshot suite twice in a row locally with no code change
  and confirm the tree stays clean. A timestamp leak will not show up in a single run.
