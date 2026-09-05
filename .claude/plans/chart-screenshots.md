# Getting chart images to render in screenshot tests

## Status

Charts are currently out of the report page — pulled pending clarity from GBD on what the
succeeded screen should show at all. This document is not an in-flight plan with PRs to fold
back; it's a note to come back to whenever charts (or any other `<img>` backed by a signed
storage URL) return to a screenshotted page. The code this refers to will have moved on by then;
treat names below as pointers into history, not a spec to match exactly.

## The problem, empirically confirmed

The screenshot suite runs its browser in a pinned Docker container (see
`e2e/setup/browser-container.ts`), reached via `host.docker.internal`. Any `<img>` whose `src`
302s to a Supabase-signed S3 URL (`/file/result/[id]` → `redirectToSignedUrl`, in
`apps/web/src/lib/server/files.ts`) breaks there, for two independent reasons — both checked
against the running test stack, not assumed:

- **The signed URL's host can't be rewritten.** `S3_ENDPOINT` in `.env.test` is `127.0.0.1`,
  which resolves to the container's own loopback, not the host running Supabase Storage. But the
  presigned URL has `X-Amz-SignedHeaders=host`, so the Host header is inside the signature —
  swapping it for `host.docker.internal` or `localhost` 403s with `SignatureDoesNotMatch`. There
  is no rewrite that works.
- **`page.route()` cannot intercept the redirected leg.** Playwright routes the request the page
  *issues*, not the request the browser follows after a 302. A route pattern matching the
  storage host never fires; the request fails with `ERR_CONNECTION_REFUSED` from inside the
  container regardless of whether a route is registered.

What does work, confirmed the same way: **routing the pre-redirect, app-origin URL**
(`**/file/result/*`) and fulfilling it directly, before the browser ever issues the request that
would 302. That request is same-origin to the app server the container already reaches via
`host.docker.internal`, so it's routable.

**An unexplored alternative, since confirmed in a different tier:** `tests/e2e/scripts/containers.ts`
(the `pnpm test:system` suite) hits the same signed-host problem and solves it without stubbing —
not by rewriting a URL after signing, but by signing with `host.docker.internal` from the start
(`S3_ENDPOINT` set to the alias before the app ever builds the URL) and making sure whoever follows
the redirect resolves that same alias. There, the app is the container and the browser is the host,
so the host needed a one-time `/etc/hosts` entry (see `assertDockerIsUsable`). For screenshots the
roles are flipped — the app is a host process and the browser is the container — but the container
already resolves `host.docker.internal` back to the host via `--add-host=host.docker.internal:host-gateway`
(`e2e/setup/browser-container.ts`). So pointing the host app's `S3_ENDPOINT` at `host.docker.internal`
for the screenshot run might let the real redirect-and-sign chain work end-to-end, no stub needed.
Not verified — worth checking before committing to the stub approach below.

## The approach

Stub the file-serving route in the screenshot project only, fulfilling from a committed image
instead of letting it redirect to storage:

```ts
// e2e/lib/stub-images.ts (name will drift — the point is what it does)
await page.route('**/file/result/*', async (route) => {
  await route.fulfill({ status: 200, contentType: 'image/png', body: /* committed PNG bytes */ });
});
```

Called before `page.goto()` in whichever screenshot test needs it.

**This doesn't need `putObject` or the blob store at all**, and shouldn't reach for it. The
redirect-and-sign chain (`redirectToSignedUrl`, `objectExists`, `signedObjectUrl`) already has
its own integration-point test — at the time of writing,
`apps/web/src/routes/file/result/[id=uuid]/download-result-file.test.ts` puts real bytes and
follows the real signed URL. A screenshot re-proving that chain would violate the testing
philosophy in `AGENTS.md` (don't re-test something that already carries its own guarantee). What
a screenshot is for here is the *layout* — how the image sits on the page — and a fulfilled
request delivers that without touching storage.

**Don't commit real generated chart images.** They're real report output and may carry real
organization data; only synthetic placeholders belong in the repo, whatever their content.

## What the placeholder images need to look like

Real charts (checked against a sample report from the older Python-based app,
`webapp/var/storage/report-artifacts/.../graphs/`) are 300-DPI matplotlib output with a wide
spread of aspect ratios — from roughly 1.5:1 up to 2.8:1 across a handful of examples, some
wider than 4000px. Two consequences worth carrying into whatever chart layout ships:

- **One fixed-ratio placeholder image hides real layout bugs.** If several figures render in a
  page, commit two or three synthetic images at different aspect ratios and cycle through them,
  rather than repeating one image — a screenshot's whole job is catching what a single ratio
  can't show, like a wide chart and a square chart stacked awkwardly in one column.
- **A downscale to a narrow content column may not preserve legibility.** A chart drawn at
  4000px+ wide with labels sized for that width can still be unreadable after being constrained
  to a typical prose column. Worth checking against a realistically wide placeholder before
  trusting that "single column, capped width" alone solves it — a link to view the image at full
  size carries more of the legibility burden than it might look like at a glance.

## A flakiness trap to close, not just note

If the eventual image is `loading="lazy"` and the screenshot is `toHaveScreenshot({ fullPage:
true })`, a lazy image below the fold may not have started loading when the capture happens.
Fulfilling instantly narrows that window but doesn't close it. Whatever helper stubs the images
should also make sure every `<img>` has finished loading before the shot — e.g. scroll through
the page (or otherwise force lazy images into view) and wait for each to report `complete`
before scrolling back — rather than relying on timing to make the test pass.
