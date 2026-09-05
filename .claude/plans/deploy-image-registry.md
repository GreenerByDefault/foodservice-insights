# Images built in CI, never at deploy time

## Context

Both Dockerfiles landed with #252; `deploy-service` is still a stub, so nothing pushes an image
anywhere yet. The pipeline's earlier design had the provider build the image from a git checkout
and CI never push one — rejecting a registry as a second place a deploy can fail, for a pipeline
whose point was one call per service. Three things that rejection did not weigh:

- **The credential cost it priced in is close to zero here.** `GreenerByDefault/foodservice-insights`
  is public, so its GHCR packages can be public: free storage, free bandwidth, and *anonymous pull*
  — the hosting provider needs no registry credential at all, and CI needs nothing beyond the
  automatic `GITHUB_TOKEN`.
- **"A second place a deploy can fail" is backwards.** Today every deploy builds, so a *rollback*
  builds — and a rollback is when you can least afford a moved RPM or a base image that no longer
  exists. Building at merge time moves that failure to a moment when nothing is on fire, and takes
  it out of the deploy entirely.
- **It predates the promotion requirement.** Staging → prod, and revert, both mean *running bytes
  that already ran*. A provider that builds from a git checkout cannot do that by construction: it
  has only a commit, so it must rebuild.

**Rebuilds are not reproducible, and making them so is not worth it.** Only uv is pinned by digest
in the two Dockerfiles. Both UBI bases float on `:latest`, the worker runtime does `microdnf
install -y python3.14` against Red Hat's errata stream, and both images `npm install -g pnpm@…`
against the npm registry. [`containers.ts`](../../tests/e2e/scripts/containers.ts) builds with
`--pull` under CI for precisely this reason — "every base image floats on `:latest`, so CI
resolves today's and would drift from a months-old local cache." A rebuild of last month's commit
is therefore a *different image*. Deploying a digest sidesteps the question rather than answering
it.

*Rejected: making the builds reproducible instead — pinning the bases and the RPM stream,
vendoring pnpm. A lot of machinery to make a rebuild safe, when not rebuilding is simpler and
total.*

**A broken Dockerfile already fails at PR time, and no PR ever pushes.** `pnpm test:system` builds
both images from the repo root and runs the whole tier through them, and `ci.yml`'s `system-e2e`
job runs it on every PR the `system` filter matches — which is every Dockerfile change, since
`system` is the one filter in [`filters.yml`](../../.github/filters.yml) that does not alias
`docker_files`. That is stronger than a `push: false` build job would have been: the images are
*run*, not merely built. Two consequences to keep in view:

- **Nothing needs to stop a PR from pushing a tag, and nothing should start.** Those builds are
  run-scoped local tags (`gbd-web:<run>`), swept by the harness. On `pull_request`, `github.sha`
  is a merge commit that exists on no branch, so a tag written for it would be permanent garbage
  no rollback can name — and a fork PR's token has no `packages` scope anyway.
- **A push to `main` builds each image twice** — once in `ci.yml` to run it, once in `deploy.yml`
  to push it. Accepted: the two want different things (a `--load`ed local tag versus a registry
  push with a shared cache), and `deploy.yml` does not wait on CI.

## One image per commit, promoted everywhere

There is no staging image and no prod image. One build per commit, addressed by digest, and every
environment runs that digest. Promotion is a pointer move, and so is a revert.

This works because the image is already environment-agnostic, and that is a *recorded* decision
rather than luck — `ARCHITECTURE.md` § Secrets: "Server config is read at runtime, not inlined at
build time — `$env/dynamic/private` rather than `$env/static/private`. One build artifact
therefore runs against any environment." **Verified** again on 2026-09-05: no `PUBLIC_*` variable
and no `$env/static/*` import exists anywhere in `apps/` or `packages/` outside SvelteKit's
generated `.svelte-kit/ambient.d.ts`, so nothing is baked in at build time today. Everything below
depends on that staying true.

| | Today | After |
| --- | --- | --- |
| Deploy | provider builds from a commit | provider runs `…/web@sha256:…` |
| Rollback | rebuild an old commit | redeploy the digest that already ran |
| Broken Dockerfile | fails the deploy | fails `system-e2e`, on the PR |

Migrations are untouched by any of this: [`deploy-migrations.md`](deploy-migrations.md) runs
`turbo run migrate` from the workspace checkout `deploy-web` already has, and that stays true
whether or not the provider is handed an image.

## The tag is the commit; the digest is the record

`ghcr.io/greenerbydefault/foodservice-insights/{web,worker}`, and **the only tag ever written is
the 40-character commit SHA** — no prefix, no `latest`, no environment marker. One commit, one
image, every environment. Lowercase is not cosmetic: `${{ github.repository }}` is
`GreenerByDefault/…` and GHCR rejects an uppercase path, so the base path is a literal rather than
an expression.

**How a deploy gets from a SHA to bytes:** the deploy names the tag, and a single
`docker buildx imagetools inspect <image>:<sha> --format '{{.Manifest.Digest}}'` reads the digest
back out of the registry. It is a manifest lookup — no layers pulled, about a second — and it
fails loudly when nothing was ever built for that commit. The provider is then handed the digest
if it accepts one, and the tag if it does not.

**We accept that OCI tags are mutable.** Anyone holding `packages: write` could repoint a commit's
tag at different bytes, and the registry will not stop them. That is the cost of treating the tag
as the identity, and it is accepted, not mitigated. Two things fall out of the design anyway and
are worth having: the build skips when the tag already exists (§ PR 1), so the workflow itself
never moves one; and the resolved digest goes into the run log and the annotated `deploy/worker`
tag, so a tag that *did* move is detectable afterwards. That is the honest claim — the resolution
is a record and a canary, not a control. Nothing stops a mover from acting between the inspect and
the provider's pull.

*Rejected: making the operator supply the digest.* It closes the gap completely, but every deploy
and every rollback then opens with a trip to the registry to copy a 71-character string, and the
commit SHA is what the rest of the pipeline — the dispatch input, `git log deploy/worker..HEAD`,
the deploy tag — is already keyed on.

*Rejected: a mutable `latest` or `prod` tag the provider follows.* It reintroduces exactly the
ambiguity the SHA removes, and invites pointing the provider at a tag that moves under it.

Three registry-housekeeping decisions follow:

- **Public packages.** GHCR appears to create a package **private on first push even from a public
  repo** — sources conflict on whether repo visibility is inherited, so check rather than assume —
  meaning each of the two likely needs a one-time flip in Package settings → Change visibility.
  Irreversible; fine here, since the images are built from public source and bake in no secrets.
- **Build cache goes in a *separate* package**, `…/cache`, tags `web` and `worker`. Then the only
  package that ever needs garbage collection is one holding zero rollback targets.
- **Never delete a commit-tagged version.** Public packages have free storage and free bandwidth,
  so there is no cost pressure to — and each one is a rollback target. This belongs as a comment in
  the build composite, where someone reaching for a cleanup workflow will read it.

## Traps that stay invisible until a deploy misbehaves

- **`deploy.yml`'s workflow-level `concurrency` block must go.** GitHub keeps one queued run per
  group, so three quick pushes cancel the middle one. Today that is harmless — a superseded deploy.
  Once that run also *builds*, cancelling it means commit B's image is never pushed, and B is
  permanently un-deployable. Workflow-level concurrency would silently punch holes in the rollback
  history the whole design exists to keep. Replace with per-job groups: `build-<service>-<sha>` and
  `deploy-<service>`, both `cancel-in-progress: false`.
- **Deploys are no longer ordered by push order.** Push A takes a base-layer change and builds for
  eight minutes; push B lands ninety seconds later and cache-hits in one. B deploys, then A's build
  finishes and A deploys — prod rolls *backwards* onto a schema that has already moved forward. The
  old whole-run concurrency masked this. `deploy-web` needs a guard, after it holds the slot, that
  compares `github.sha` against the current tip of `main` and skips when it is behind. Push-only: a
  `workflow_dispatch` deliberately names a non-tip SHA — that is the rollback path.
- **`needs:` on a job that is skipped.** A plain boolean `if:` is implicitly ANDed with `success()`
  over `needs`, so on a dispatch (where `build-web` is skipped) `deploy-web` would skip too. Naming
  a status function takes the gate over — and it must be `!cancelled()`, never `always()`, which
  would deploy straight through an operator hitting Cancel:

  ```yaml
  if: >-
    !cancelled() && needs.build-web.result != 'failure' && needs.build-web.result != 'cancelled'
    && (github.event_name == 'push' || inputs.service == 'web')
  ```

  `deploy-worker` gets **no** `needs:` edge at all — it never runs on `push`, so the edge would gate
  on nothing while forcing a status function into an `if:` that reads fine today.
- **The classic GHCR cleanup footgun.** `docker/build-push-action` defaults `provenance: true`, and
  those attestation manifests show up as *untagged versions* even though the tagged index
  references them. The popular "delete all untagged versions" recipes then break pulls of images
  that are still tagged, with `manifest unknown`. Set `provenance: false` and `sbom: false`, which
  removes the clutter that motivates the cleanup in the first place.

## PR 1 — Build and push both images on every push to `main`

Deploys stay stubbed — the images can sit unused for weeks while the provider question resolves,
and every day they sit there they extend the rollback history.

- New `.github/actions/build-image/action.yml`: `docker/setup-buildx-action`,
  `docker/login-action` against `ghcr.io` with `GITHUB_TOKEN`, then `docker/build-push-action` with
  `context: .`, `file: apps/<service>/Dockerfile`, `platforms: linux/amd64` (what UBI was verified
  on; arm64 would double the build for nothing), `provenance: false`, `sbom: false`, and
  `cache-from`/`cache-to` at `type=registry,…/cache:<service>,mode=max`. `mode=max` matters: without
  it a multi-stage build caches only the final stage and throws away the expensive part. Labels
  `org.opencontainers.image.source` (this is what links the package to the repo, so `GITHUB_TOKEN`
  has write access) and `…revision`.
- **Skip the build when the commit's tag already exists**, with an `::notice::` so it is never
  silent. That is what keeps the workflow from ever moving a tag, and it makes a re-run cheap. Its
  real use is re-running a run whose *deploy* failed after a good build; on `main` every push has a
  fresh SHA, so it rarely fires. Add a `force_rebuild` dispatch input so a bad image is not
  permanently sticky.
- `deploy.yml`: two jobs, `build-web` and `build-worker`, both `if: github.event_name == 'push'`,
  both `permissions: {contents: read, packages: write}` (a job-level block *replaces* the
  workflow-level one, so `contents: read` must be restated or `checkout` breaks). Both build on
  every push even though only web auto-deploys — a later worker dispatch, or a revert to any commit,
  needs an image waiting.
- Remove the workflow-level `concurrency` block; add per-job groups (see Traps).
- `deploy-web` gains `needs: build-web` and the `if:` above.

*Rejected: a matrix over `[web, worker]`.* `needs:` has no per-leg granularity, so every web deploy
— the path that runs migrations — would wait on the slower Node+Python worker build, and a worker
build failure would block it outright.

*Rejected: a separate `build-images.yml` triggering deploys via `workflow_run`.* It always runs the
default branch's copy of the workflow, has an awkward context, and buys nothing at this size.

*Rejected: `type=gha` cache.* Seven-day eviction on last access, which is exactly this workload; and
it shares the repo's 10GB cache budget with `setup-node`, `setup-python`, and
`playwright-browsers`, so multi-GB layer caches would make every other job slower.

*Considered, not done: pointing `system-e2e`'s build at the same `…/cache` package.* The package is
public, so a PR build could `cache-from` it anonymously — but never `cache-to`, since a fork PR's
token cannot write it, and a cache only one side fills is a cache that quietly rots. The build costs
roughly 30s in that job today; revisit if it grows, not before. `containers.ts` also passes
`--pull` under CI, which a warm layer cache would partly defeat — the drift it surfaces is the
point.

## PR 2 — Deploy by digest, never by rebuild

Manual first, and it will 401 otherwise: flip both packages to public, then confirm from a laptop
with `docker logout ghcr.io && docker buildx imagetools inspect …`.

- `deploy-service` keeps its `service` + `sha` inputs and gains the resolution step described in
  § The tag is the commit. Run it **unauthenticated** — it is the same pull the provider will make,
  so a failure here is the earliest warning that a package is private. Use
  `--format '{{.Manifest.Digest}}'`; `{{json …}}` includes the quotes and would be pasted straight
  into a provider call.
- Its failure message must name both causes, because a bare `imagetools` error is unreadable: no
  build ran for this commit, or the package is still private.
- Normalize the SHA first. `actions/checkout` accepts a 7-char SHA or a branch name; the tag lookup
  needs the exact 40 characters. `git rev-parse HEAD` after checkout, and pass *that*.
- Add the supersession guard to `deploy-web` (see Traps), **above the migrate step** that
  [`deploy-migrations.md`](deploy-migrations.md) adds, so a superseded run does nothing at all
  rather than migrating and then declining to deploy. The two gates compose — that one skips when a
  SHA was named, this one when `main` has moved past an unnamed one — but they read as one rule
  only if they sit together.
- Make the `deploy/worker` tag annotated and put the digest in its message, so `git show
  deploy/worker` names the exact bytes independent of the registry.
- `ARCHITECTURE.md` now, since it is true: a Registry row in § Stack, and § Hosting gains that a
  deploy is a promotion of an existing image and a rollback redeploys the bytes that already ran.
  Keep it immediately beside the existing forward-only migration sentence — **a rollback is fast
  and reproducible, not safe**, and that distinction is what someone reads at 2am.

## Verification

Each PR's own check is `pnpm lint && pnpm check && pnpm test` from the repo root. That the images
*build and run* is already `system-e2e`'s job, on the PR — what is unproven here is the registry
mechanics, and only running the pipeline proves those:

- **PR 1.** Push to `main`; confirm two packages appear and `docker buildx imagetools inspect` both.
  Re-run the same workflow run and confirm the build skips with its notice.
- **PR 2.** After the visibility flip, `docker logout ghcr.io` and inspect anonymously — that is
  what proves the provider will not need a credential. Then dispatch a deploy at an *older* SHA and
  confirm from the log that it resolved a digest and never built. Dispatch a SHA that was never on
  `main` and confirm it fails with the explanatory message rather than a bare 404. Confirm the
  supersession guard skips the migrate step too, not just the deploy.
- **Rollback, end to end,** once a provider exists: deploy commit A, then B, then dispatch A again;
  confirm the provider reports the same digest it ran the first time. That is the whole point of
  the plan, and it is the only check that tests it.
