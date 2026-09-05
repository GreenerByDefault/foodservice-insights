# Images built in CI, never at deploy time

## Context

`deploy.yml` now builds both images on every push to `main` and pushes them to GHCR tagged with the
commit SHA. Nothing consumes them yet: `deploy-service` is still the stub it has always been, so
every deploy is a `::warning::` and the images sit in the registry accumulating rollback targets.
This plan is the remaining half — teaching the deploy to resolve a SHA to a digest and hand it to a
provider, instead of handing over a commit for the provider to build.

The pipeline's earlier design had the provider build the image from a git checkout and CI never
push one — rejecting a registry as a second place a deploy can fail, for a pipeline whose point was
one call per service. Three things that rejection did not weigh:

- **The credential cost it priced in is close to zero here.** `GreenerByDefault/foodservice-insights`
  is public, so its GHCR packages can be public: free storage, free bandwidth, and *anonymous pull*
  — the hosting provider needs no registry credential at all, and CI needs nothing beyond the
  automatic `GITHUB_TOKEN`.
- **"A second place a deploy can fail" is backwards.** A deploy that builds means a *rollback*
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

**A broken Dockerfile fails at PR time, and no PR ever pushes.** `pnpm test:system` builds both
images from the repo root and runs the whole tier through them, and `ci.yml`'s `system-e2e` job
runs it on every PR the `system` filter matches — which is every Dockerfile change, since `system`
is the one filter in [`filters.yml`](../../.github/filters.yml) that does not alias `docker_files`.
Those builds are run-scoped local tags (`gbd-web:<run>`) that the harness sweeps, and nothing
should ever make them push: on `pull_request`, `github.sha` is a merge commit that exists on no
branch, so a tag written for it would be permanent garbage no rollback can name — and a fork PR's
token has no `packages` scope anyway. The cost is that a push to `main` builds each image twice,
once in `ci.yml` to run it and once in `deploy.yml` to push it. Accepted: the two want different
things (a `--load`ed local tag versus a registry push with a shared cache), and `deploy.yml` does
not wait on CI.

## One image per commit, promoted everywhere

There is no staging image and no prod image. One build per commit, addressed by digest, and every
environment runs that digest. Promotion is a pointer move, and so is a revert.

**Both services build on every push, whichever one deploys.** A commit that built only web is a
commit the worker can never be rolled back to, so the build jobs are gated on the event and not on
which service changed — there is no paths filter on them and there should not be one. It stays
affordable because an unchanged rebuild hits the registry layer cache end to end and republishes an
identical manifest, which GHCR stores as one more tag on bytes it already has.

This works because the image is already environment-agnostic, and that is a *recorded* decision
rather than luck — `ARCHITECTURE.md` § Secrets: "Server config is read at runtime, not inlined at
build time — `$env/dynamic/private` rather than `$env/static/private`. One build artifact
therefore runs against any environment." **Verified** on 2026-09-05: no `PUBLIC_*` variable and no
`$env/static/*` import exists anywhere in `apps/` or `packages/` outside SvelteKit's generated
`.svelte-kit/ambient.d.ts`, so nothing is baked in at build time today. Everything below depends on
that staying true.

| | Today | After |
| --- | --- | --- |
| Deploy | stub warns; would build from a commit | provider runs `…/web@sha256:…` |
| Rollback | rebuild an old commit | redeploy the digest that already ran |
| Broken Dockerfile | fails `system-e2e`, on the PR | unchanged |

Migrations are untouched by any of this: [`deploy-migrations.md`](deploy-migrations.md) runs
`turbo run migrate` from the workspace checkout `deploy-web` already has, and that stays true
whether or not the provider is handed an image.

## The tag is the commit; the digest is the record

`ghcr.io/greenerbydefault/foodservice-insights/{web,worker}`, and **the only tag ever written is
the 40-character commit SHA** — no prefix, no `latest`, no environment marker. One commit, one
image, every environment. Lowercase is not cosmetic: `${{ github.repository }}` is
`GreenerByDefault/…` and GHCR rejects an uppercase path, which is why
[`build-image`](../../.github/actions/build-image/action.yml) lowercases it into a step output.

**How a deploy gets from a SHA to bytes:** the deploy names the tag, and a single
`docker buildx imagetools inspect <image>:<sha> --format '{{.Manifest.Digest}}'` reads the digest
back out of the registry. It is a manifest lookup — no layers pulled, about a second — and it
fails loudly when nothing was ever built for that commit. The provider is then handed the digest
if it accepts one, and the tag if it does not.

**We accept that OCI tags are mutable.** Anyone holding `packages: write` could repoint a commit's
tag at different bytes, and the registry will not stop them. That is the cost of treating the tag
as the identity, and it is accepted, not mitigated. Two things fall out of the design anyway and
are worth having: the build skips when the tag already exists, so the workflow moves a tag only
when an operator passes `force_rebuild`; and the resolved digest will go into the run log and the
annotated `deploy/worker` tag, so a tag that *did* move is detectable afterwards. That is the
honest claim — the resolution is a record and a canary, not a control. Nothing stops a mover from
acting between the inspect and the provider's pull.

*Rejected: making the operator supply the digest.* It closes the gap completely, but every deploy
and every rollback then opens with a trip to the registry to copy a 71-character string, and the
commit SHA is what the rest of the pipeline — the dispatch input, `git log deploy/worker..HEAD`,
the deploy tag — is already keyed on.

*Rejected: a mutable `latest` or `prod` tag the provider follows.* It reintroduces exactly the
ambiguity the SHA removes, and invites pointing the provider at a tag that moves under it.

## What the build side already settled

Recorded here because the deploy side depends on each one, and because two of them reversed
decisions this plan used to state the other way round.

- **`force_rebuild` builds only the service being deployed.** It is the one thing in the workflow
  that deliberately moves an existing tag, so it moves exactly the tag the operator named. On
  `push` both services build unconditionally; the service gate applies to dispatches only.
- **`deploy-worker` has a `needs: build-worker` edge**, which this plan previously argued against
  on the grounds that the worker never builds on `push` so the edge would gate on nothing.
  `force_rebuild` is what made that false: without the edge, a force-rebuild dispatch would resolve
  a digest while its own rebuild was still running, and deploy the bytes it was called to replace.
  Both deploy jobs therefore carry the `!cancelled() && …result != 'failure' && …result !=
  'cancelled'` form — a plain boolean `if:` is implicitly ANDed with `success()` over `needs`, so a
  dispatch that skips the build would skip the deploy with it, and `always()` would deploy straight
  through an operator hitting Cancel.
- **Concurrency is per-job, never workflow-level.** `build-<service>-<sha>` and `deploy-<service>`,
  all `cancel-in-progress: false`. A workflow-level group would let three quick pushes cancel the
  middle one, and a cancelled run that also *builds* leaves commit B permanently un-deployable —
  holes punched in exactly the rollback history this design exists to keep.
- **`provenance: false` and `sbom: false`.** Attestation manifests show up as untagged package
  versions even though the tagged index references them, so the popular "delete all untagged
  versions" GHCR cleanup recipes break pulls of images that are still tagged, with `manifest
  unknown`. Not generating them removes what motivates the cleanup.
- **Never delete a commit-tagged version.** Each one is a rollback target, and public packages have
  free storage and free bandwidth, so there is no cost pressure to. The build cache lives in a
  separate `…/cache` package for this reason: it is the only one ever safe to garbage-collect.

*Rejected: `type=gha` cache.* Seven-day eviction on last access, which is exactly this workload; and
it shares the repo's 10GB cache budget with `setup-node`, `setup-python`, and
`playwright-browsers`, so multi-GB layer caches would make every other job slower.

*Rejected: sharing the `…/cache` package with `system-e2e`'s build.* The cache package stays
private — nothing anonymous needs it, and it is the one package whose contents are build internals
rather than a release artifact. That forecloses a fork PR reading it, and the ~30s a warm cache
would save that job is not worth making build internals public for. `containers.ts` also passes
`--pull` under CI, which a warm layer cache would partly defeat; the drift that surfaces is the
point of running it there.

## PR 1 — Deploy by digest, never by rebuild

Manual first, and it will 401 otherwise: flip both **service** packages to public — GHCR appears to
create a package private on first push even from a public repo, and sources conflict on whether
repo visibility is inherited, so check rather than assume. The flip is in Package settings → Change
visibility and is irreversible; fine here, since the images are built from public source and bake
in no secrets. Leave `…/cache` private. Then confirm from a laptop with
`docker logout ghcr.io && docker buildx imagetools inspect …`.

- `deploy-service` keeps its `service` + `sha` inputs and gains the resolution step described in
  § The tag is the commit. Run it **unauthenticated** — it is the same pull the provider will make,
  so a failure here is the earliest warning that a package is private. Use
  `--format '{{.Manifest.Digest}}'`; `{{json …}}` includes the quotes and would be pasted straight
  into a provider call. (`build-image` checks tag existence with `docker manifest inspect`, which
  needs no buildx; the two are different tools for different jobs, not an inconsistency to unify.)
- Its failure message must name both causes, because a bare `imagetools` error is unreadable: no
  build ran for this commit, or the package is still private.
- Normalize the SHA first. `actions/checkout` accepts a 7-char SHA or a branch name; the tag lookup
  needs the exact 40 characters. `git rev-parse HEAD` after checkout, and pass *that*.
- **Add the supersession guard to `deploy-web`.** Deploys are no longer ordered by push order:
  push A takes a base-layer change and builds for eight minutes, push B lands ninety seconds later
  and cache-hits in one, so B deploys and then A's build finishes and A deploys — prod rolls
  *backwards* onto a schema that has already moved forward. The whole-run concurrency that used to
  mask this is gone. After the job holds its slot, compare `github.sha` against the current tip of
  `main` and skip when it is behind. Push-only: a `workflow_dispatch` deliberately names a non-tip
  SHA — that is the rollback path. It belongs **above the migrate step** that
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

`pnpm lint && pnpm check && pnpm test` from the repo root covers nothing here; both halves of this
design are only proven by running the pipeline.

**Still owed from the build side**, which merged before it could be exercised — a build job only
runs on a push to `main`:

- Confirm two service packages and one cache package appear, and `docker buildx imagetools inspect`
  both service images.
- Re-run the same workflow run and confirm the build skips with its `::notice::`.
- Dispatch with `force_rebuild` and confirm it rebuilds *only* the named service, and that the
  deploy job waits for that rebuild rather than racing it.

**PR 1.** After the visibility flip, `docker logout ghcr.io` and inspect anonymously — that is what
proves the provider will not need a credential. Then dispatch a deploy at an *older* SHA and
confirm from the log that it resolved a digest and never built. Dispatch a SHA that was never on
`main` and confirm it fails with the explanatory message rather than a bare 404. Confirm the
supersession guard skips the migrate step too, not just the deploy.

**Rollback, end to end,** once a provider exists: deploy commit A, then B, then dispatch A again;
confirm the provider reports the same digest it ran the first time. That is the whole point of the
plan, and it is the only check that tests it.
