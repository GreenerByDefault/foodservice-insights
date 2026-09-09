# Web e2e tests

Two suites share this directory, separated by suffix and by Playwright project:

| Suffix | Asserts | Runs in |
| --- | --- | --- |
| `*.e2e.ts` | behaviour | host browser |
| `*.screenshot.ts` | pixels | browser in Docker |

See [`../playwright.config.ts`](../playwright.config.ts).

`pnpm test:playwright` (what `pnpm test` runs) runs both in one app boot. To scope to just one
suite, `pnpm test:e2e` or `pnpm test:screenshots`.

## Layout

The suffix decides which runner and browser a file gets, so directories are free to carry the
other axis: **what part of the product a spec covers.**

| | |
| --- | --- |
| `lib/` | Helpers a spec imports. No tests, no side effects at import — except `lib/poll-interval.ts`, which reads `WORKER_MODE` at import, the same caveat `@gbd/browser-testing/fixtures` calls out for `@gbd/db/env`. |
| `fixtures/` | The report-state catalogue, the built-to-spec organization builder, and the extended `test` that commits and cleans up both — on top of the shared identity and organization in [`@gbd/browser-testing/fixtures`](../../../packages/browser-testing/src/fixtures.ts). |
| `setup/` | Getting the containerized browser up, taking it down, and optimizing screenshots afterward. Not tests of the app. |
| `__screenshots__/` | The committed PNGs, nested to match the spec that captures them, and by viewport. |
| everything else | Specs, both suites. |

**Specs stay flat until a feature has two of them, then that feature gets a folder** holding both
its suites.

`__screenshots__/` mirrors that same nesting (`snapshotPathTemplate` in
[`../playwright.config.ts`](../playwright.config.ts) keys it off the spec's own directory), so a
shot's name only has to be unique within its feature — `reports/failed.png`, not
`reports-failed.png`. It's still browsed as a gallery, one folder per feature.

Every spec is captured at each viewport in [`lib/viewports.ts`](lib/viewports.ts).

## Screenshots

`__screenshots__/` is our visual regression suite, and doubles as a gallery for humans and AI to
see how the app looks.

The containerized browser stays running between local runs, so repeat `test:screenshots` runs
skip its ~2s startup and concurrent runs don't fight over tearing it down. Optionally, you
can run `pnpm test:browser:stop` to free the memory when you're done.

After an intentional visual change, update the committed PNGs:

```sh
pnpm turbo run screenshots:update --filter=@gbd/web
```

Run that for whatever Playwright's failure output suggests — it's the fix regardless of what
changed. It also runs `oxipng` to shrink file size (`brew install oxipng` or `cargo install oxipng`).

Keep the set curated. The unit to weigh is a *screen*, not an image — adding one costs an image
per viewport, and every one of them is CI minutes and a file a reviewer has to look at on any
visual change. Capture screens that carry real visual risk, not every route.

**Stubs don't get a screenshot until they're implemented.**

## Database state

`e2e/fixtures/reports.ts` is the source of truth for what each report state contains.

There's no shared reset. Every test gets its own `org` — a private organization the signed-in
`user` administers — and it is deleted when the test ends, whether it passed or failed. `report`
and `organization_member` cascade from it, so anything committed inside goes with it, including a
report the spec created through the UI or the API rather than through the `reports` fixture. Both
come from [`@gbd/browser-testing/fixtures`](../../../packages/browser-testing/src/fixtures.ts),
shared with `tests/e2e`; `identity.ts` beside it is the only place either suite refers to the
phase-one placeholder user.

Screenshots and e2e share the catalogue of report states, not any rows, so a behavioural spec is
free to mutate what it created without affecting another test.

A spec that needs more of an organization than that — a whole list of reports, a roster, a view
through a non-admin's eyes — asks the `organizations` fixture (`e2e/fixtures/test.ts`) for a
second one built to a spec, and `organizations.adopt(id)` registers one the UI created for the
same cleanup.

A screenshot spec that renders the switcher pins `org`'s name with `test.use({ orgName })`, since
its committed image is diffed pixel-for-pixel. A pinned name is shared across the run rather than
per-test — `organization_name_unique_ci` is global, and two tests holding one name at once would
collide — so the spec's tests stay parallel instead of serializing behind it. Pin one only from a
spec that reads the organization; one that renames it, deletes it, or asserts on the whole of its
reports list wants `organizations.create` instead.

One screen still has no fixture that can reach it: an empty `/orgs`. Every spec shares one
identity, so that user belongs to every organization any concurrent test creates.
`lib/stub-page-data.ts` rewrites the page-data response instead — a temporary stand-in for real
sign-in, same as `identifyUser`.

## Pending

`identifyUser` always resolves to one seeded user (see `auth.e2e.ts`) — there's no way yet to
drive a signed-out request through a real route to see its 401. Add one e2e per row once real
sign-in lands. An admin-gated route's 403 is already drivable, though: the `organizations` fixture
can create an org where the signed-in user is only a `member` (see
`organizations/settings.e2e.ts`).

| Route | Unit coverage today |
| --- | --- |
| `POST orgs` (create) | `create-organization.test.ts` |
| `PATCH orgs/:id` (rename) | `rename-organization.test.ts` |
| `DELETE orgs/:id` | `delete-organization.test.ts` |
| `POST orgs/:id/reports` (create) | `create-report.test.ts` |
| `GET orgs/:id/reports/:id` (view) | `load-report.test.ts` |
| `DELETE orgs/:id/reports/:id` | `delete-report.test.ts` |
| `POST orgs/:id/invites` (create) | none |
| `DELETE orgs/:id/invites/:id` (revoke) | none |
| `POST invites/:id/accept` | none |
| `POST invites/:id/decline` | none |
| `GET sign-in` | none |
