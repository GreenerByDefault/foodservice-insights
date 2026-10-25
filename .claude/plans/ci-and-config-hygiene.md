# CI and config hygiene

## Context

From the end-of-phase audit, re-checked against `main` on 2026-10-25:

- **A lab-only PR is never typechecked.** `.github/filters.yml`'s `python` filter excludes
  `python/lab/**`, so such a PR skips `py-static` (`just lint && just check`). `py-lab` then runs
  `just lint` and `just test-lab`, never `just check`, although `just check` is
  `ty check python scripts`, which covers the lab. A ty error in the lab lands on `main` and fails
  the next unrelated Python PR.
- **`filters.yml:12-13` describes a backstop that does not exist.** It says "`push: main` runs
  everything unfiltered as a second backstop"; `ci.yml:3` says "No `push`". The real backstop is
  the merge queue: on `merge_group`, `UNFILTERED` is true and every job runs.
- **The edit hook under-formats Python and Markdown.** `.claude/hooks/format-file.sh` runs only
  `ruff format` on `*.py`, never `ruff check --fix`, so import order (rule `I`) is left for
  `just lint` to fail on; and it skips `*.md`, which ruff does format (`ruff format --check -v`
  lists them). An agent's edit passes the hook and fails the gate.
- **uv is pinned twice by hand, and nothing bumps the image pin.** `apps/worker/Dockerfile:12`
  pins `ghcr.io/astral-sh/uv` by bare digest with no version comment;
  `.github/actions/setup-python/action.yml` pins `0.11.27`. `dependabot.yml` has no `docker`
  ecosystem, and Dependabot cannot bump a tagless digest anyway.
- **A local image build would ship GBD's private cache.** An untracked
  `python/insights/gbd_foodservice_insights/data_files/previously_categorized_items.csv` can sit
  in a checkout (the product no longer reads it; the lab's `product_cache.py` header says so).
  `apps/worker/Dockerfile:26` copies that directory whole and Hatchling ships every non-Python
  file, and `.dockerignore` excludes only build output. CI checkouts are clean, so production is
  unaffected.
- **The two Dockerfiles disagree about pnpm.** `apps/web/Dockerfile:25-28` says
  `--frozen-lockfile` "needs every workspace member the lockfile knows about to have a
  package.json on disk", yet the worker's builder copies only its own dependency closure and
  builds fine in CI. The web copies `browser-testing`'s manifest because it is in `@gbd/web`'s
  closure (a devDependency), which is the accurate reason.
- **The env-var lists have drifted.** `turbo.json`'s `globalPassThroughEnv` lacks
  `PLATFORM_SHUTDOWN_GRACE_MS`, `CACHE_DB_CONNECTION_STRING` and `WORKER_DRAIN_GRACE_MS`, all
  read by `apps/worker/src/main.ts`; `.env.example` names `LOG_LEVEL` only in a comment, while
  `.env.test` sets it. Turbo's strict env filters a shell-set variable the list omits. Two tests
  already cross-check neighbouring lists (`apps/worker/src/config.test.ts` reads `.do/worker.yaml`
  and `.env.example`; `packages/db/src/budget.test.ts` reads the `.do` instance counts); nothing
  checks these.
- **Seven per-package `test` scripts exist and nothing calls them.** `apps/web`'s is a trap:
  `pnpm run test:unit && pnpm run test:playwright` runs Playwright without Turbo's rebuild, which
  `.claude/rules/typescript.md` § Verifying a change warns silently tests the previous build.
- **Stale workspace entries.** `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude:
  shadcn-svelte@1.5.0` matches nothing (the lock resolves 1.7.0). Of the five security
  `overrides`, `cookie@<0.7.0` is inert (only 1.1.1 and 2.0.1 are in the graph); the others
  resolve above their floors but confirming needs `pnpm audit` with them removed. The bits-ui
  patch's upstream, huntabyte/bits-ui#2166, was closed unmerged on 2026-09-19, so its "fix
  released" condition will not arrive from that PR. `@internationalized/date` is the one
  peer-only catalog entry without a comment saying so. `apps/worker` declares `pg` and
  `@types/pg` as devDependencies and imports neither; `tests/e2e` declares `@gbd/storage` and
  `@gbd/web` and its README explains only `@gbd/worker`.
- **`pytest`'s `testpaths` is `["python"]`**, so the bare `uv run pytest` that `python/README.md`
  recommends skips `scripts/ci/tests`, which `just test` runs.

## Decisions

- **Every PR here is small and independent; land them in any order.** Nothing waits on a live
  plan, and nothing here changes behaviour a user sees.
- **CI gets exactly one more step.** `py-lab` runs `just check` after `just lint`. It costs about
  20 seconds and closes the only gap where a gate does not run on the files that need it.
  *Rejected: moving the lab under the `python` filter.* It would run the product's unit tests
  on every lab edit for no reason.
- **Filters stay as they are.** The `system`, `ts` and `python` filters fire on some files that
  cannot affect them (`scripts/ci/**`, `.do/**`, `deploy.yml`, Python test files for `system`).
  Minutes are free on a public repo, the merge queue runs everything regardless, and
  `filters.yml` says to add only an exclusion you can defend out loud. Not worth the risk of a
  wrong exclusion.
- **UBI bases stay `:latest`**, as the deleted `deploy-docker-images.md` decided. Only the uv
  image pin changes form, to `uv:<version>@sha256:…`, so Dependabot's `docker` ecosystem can bump
  it and so a reader sees the version. The CI pin stays separate; the two gain a comment naming
  each other. *Rejected: a BuildKit cache mount for uv and pnpm.* Builds are already
  registry-cached and take a few minutes.
- **The hook grows, the gate does not shrink.** `format-file.sh` adds `ruff check --fix --select I`
  for `*.py` and runs `ruff format` on `*.md` too. It still exits 0 on any failure; `just lint`
  stays the gate.
- **The env-var lists get a test, not a doc.** A test in `apps/worker` (beside `config.test.ts`,
  which already reads `.env.example`) asserts that every uncommented variable in `.env.example`
  appears in `turbo.json`'s `globalPassThroughEnv` or `globalEnv`, and in `apps/web/src/env.ts`
  if the web reads it. One direction only: turbo may list test-only variables `.env.example` does
  not. *Rejected: generating one list from another.* Five files read the variables for five
  reasons; a check that they agree is enough.
- **Delete the per-package `test` scripts** rather than fix them. `pnpm test` at the root is the
  documented entry (`docs/typescript.md` § Everyday commands), and the rule file already says
  Playwright goes through Turbo. `apps/worker`'s `start` stays: it is how a person runs the built
  worker, and the Dockerfile's "never `pnpm start`" is about PID 1 in a container.
- **Workspace entries: drop what is inert, document what is not.** Remove the stale release-age
  exclusion; remove the five `overrides`, run `pnpm install` and `pnpm audit`, and put back only
  what audit still flags, each with today's date; rewrite the bits-ui patch comment to say
  upstream closed #2166 unmerged, so the condition is "bits-ui's changelog mentions PinInput's
  deferred selection sync"; comment `@internationalized/date` like its neighbours; drop the
  worker's `pg` devDependencies if `pnpm check` and `pnpm test:unit` pass without them; give
  `tests/e2e`'s other two `@gbd/*` devDependencies the README sentence `@gbd/worker` has, or
  remove them.
- **`.dockerignore` gains the private-cache glob**, `**/data_files/previously_*.csv`, matching
  `.gitignore`'s two "handed out privately" lines. `.gitignore` keeps its broad form: narrowing
  it to the lab path would un-ignore a stale product-path copy on any machine that still has one.

## PR 1 — CI and Docker

- `.github/workflows/ci.yml`: `py-lab` gains `- run: just check` after `just lint`.
- `.github/filters.yml:12-13`: the backstop is the merge queue's unfiltered run, not `push: main`.
- `apps/worker/Dockerfile:12`: `ghcr.io/astral-sh/uv:0.11.27@sha256:<that version's digest>`, with
  a comment pointing at `setup-python/action.yml`, and the reverse comment there.
- `.github/dependabot.yml`: a `docker` ecosystem entry for `/apps/worker` and `/apps/web`, weekly.
- `apps/web/Dockerfile:25-28`: the comment says `browser-testing` is in `@gbd/web`'s dependency
  closure, which is why its manifest is needed and the worker's builder copies none.
- `.dockerignore`: the private-cache glob, with one line saying why.
- Verification: a lab-only change with a deliberate ty error fails `py-lab`; Dependabot's next
  run opens a `docker` PR or reports the pin current; `docker build -f apps/worker/Dockerfile .`
  on a checkout holding the stale CSV produces an image whose site-packages lacks it.

## PR 2 — Local tooling and the env lists

- `.claude/hooks/format-file.sh`: `ruff check --fix --select I` then `ruff format` for `*.py`;
  `ruff format` for `*.md`. Keep the "always exits 0" header true.
- `turbo.json`: the three missing worker variables in `globalPassThroughEnv`.
- `.env.example`: a `LOG_LEVEL` line, commented like `LOG_FORMAT`, beside it.
- `apps/worker/src/env-lists.test.ts` (or a block in `config.test.ts`): the one-direction check
  from Decisions. It reads `.env.example`, `turbo.json` and `apps/web/src/env.ts` as text, the way
  `config.test.ts` already reads the first.
- `pyproject.toml`: `testpaths = ["python", "scripts"]`, and `python/README.md`'s sentence about a
  bare `uv run pytest` stays true. (`documentation-revamp.md` PR 3 owns the rest of that file.)
- Verification: edit a `.py` file to an unsorted import through Claude and watch the hook fix it;
  `just lint`, `pnpm lint && pnpm check && pnpm test`, and the new test failing when a variable is
  removed from `turbo.json`.

## PR 3 — Package scripts and workspace entries

- Delete `test` from `apps/web`, `apps/worker`, `apps/grafana`, `packages/core`, `packages/db`,
  `packages/email` and `packages/storage` `package.json`s.
- `pnpm-workspace.yaml`: as in Decisions. Run `pnpm install` and `pnpm audit`; commit the lock
  only if it changed.
- `apps/worker/package.json`: drop `pg` and `@types/pg` if the gate passes without them.
- `tests/e2e/package.json` and `tests/e2e/README.md` (the `@gbd/worker` paragraph): the hash-input
  sentence covers all three `@gbd/*` devDependencies, or the two unexplained ones go.
- This PR deletes this plan.
- Verification: `pnpm install` is clean (no "unused patch", no peer warnings);
  `pnpm lint && pnpm check && pnpm test`.
