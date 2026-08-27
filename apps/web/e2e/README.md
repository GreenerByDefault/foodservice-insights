# Web e2e tests

Two suites share this directory, separated by suffix and by Playwright project:
`*.e2e.ts` asserts behaviour on the host browser, `*.screenshot.ts` captures pixels through a
browser in Docker. See [`../playwright.config.ts`](../playwright.config.ts).

## Layout

The suffix decides which runner and browser a file gets, so directories are free to carry the
other axis: **what part of the product a spec covers.**

| | |
| --- | --- |
| `lib/` | Helpers a spec imports. No tests, no side effects at import. |
| `setup/` | Getting the containerized browser up, and taking it down. Not tests of the app. |
| `__screenshots__/` | The committed PNGs, flat. |
| everything else | Specs, both suites. |

**Specs stay flat until a feature has two of them, then that feature gets a folder** holding both
its suites.

`__screenshots__/` stays flat however the specs nest, because it is browsed as a gallery. That
makes the shot names a global namespace, so prefix them with the feature the way a folder would:
`reports-failed.png`, not `failed.png`.

## Screenshots

`__screenshots__/` is committed, and is a gallery as much as a regression check: GitHub renders
an image swipe in the PR, an agent can read the PNGs, and the folder can be shown to a client.
After an intentional visual change:

```sh
pnpm --filter @gbd/web run screenshots:update
```

That is the command to reach for whatever Playwright's failure output suggests. It also runs
`oxipng`, if you have it (`brew install oxipng`) — optional, and only about file size.

Keep the set curated. Every image is CI minutes and repository bytes forever, so capture what
carries real visual risk rather than every route.

Assert something directly, rather than screenshot it, only when a screenshot could not show
it — content silently cut off, or a defect at a viewport width nothing is captured at. That is
what [`layout.e2e.ts`](layout.e2e.ts) is for, and why it should stay small.

**Open:** every state worth capturing beyond the 404 page needs fixtures that pin their
timestamps, or the images differ on every run. See `.claude/plans/visual-testing.md`.

## Pending

`requireAuth`/`requireOrganizationAccess` guard every route below, but `identifyUser` always
resolves to one seeded user (see `auth.e2e.ts`) — there's no way yet to drive a bystander or
signed-out request through a real route to see its 401/403. Add one e2e per row once real
sign-in lands.

| Route | Unit coverage today |
| --- | --- |
| `POST orgs/:id/reports` (create) | `create-report.test.ts` |
| `GET orgs/:id/reports/:id` (view) | `load-report.test.ts` |
| `POST orgs/:id/reports/:id/cancel` | `cancel.test.ts` (calls `requestCancellation` directly, bypassing auth) |
| `DELETE orgs/:id/reports/:id` | `delete-report.test.ts` |
