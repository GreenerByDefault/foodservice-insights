# Web e2e tests

Two suites share this directory, separated by suffix and by Playwright project:

| Suffix | Asserts | Runs in |
| --- | --- | --- |
| `*.e2e.ts` | behaviour | host browser |
| `*.screenshot.ts` | pixels | browser in Docker |

See [`../playwright.config.ts`](../playwright.config.ts).

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

`__screenshots__/` is our visual regression suite, and doubles as a gallery for humans and AI to
see how the app looks.

After an intentional visual change, update the committed PNGs:

```sh
pnpm --filter @gbd/web run screenshots:update
```

Run that for whatever Playwright's failure output suggests — it's the fix regardless of what
changed. It also runs `oxipng`, if you have it (`brew install oxipng`), to shrink file size.

Keep the set curated: every image is CI minutes and repository bytes forever, so capture routes
that carry real visual risk, not every route.

Screenshots can't show everything, though — a defect that's cut off, or one that only appears at
an uncaptured viewport width, needs a direct assertion instead. For example, that's what
[`layout.e2e.ts`](layout.e2e.ts) is for.
Reach for assertions only when a screenshot genuinely can't see the problem.

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
