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
| `fixtures/` | The report-state catalogue and the extended `test` that commits and cleans up a report. |
| `setup/` | Getting the containerized browser up, the database reset, and taking the browser down. Not tests of the app. |
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
pnpm turbo run screenshots:update --filter=@gbd/web
```

Run that for whatever Playwright's failure output suggests — it's the fix regardless of what
changed. It also runs `oxipng` to shrink file size (`brew install oxipng` or `cargo install oxipng`).

Keep the set curated: every image is CI minutes and repository bytes forever, so capture routes
that carry real visual risk, not every route.

Screenshots can't show everything, though — a defect that's cut off, or one that only appears at
an uncaptured viewport width, needs a direct assertion instead. For example, that's what
[`layout.e2e.ts`](layout.e2e.ts) is for.
Reach for assertions only when a screenshot genuinely can't see the problem.

## Database state

Every fixture lives in the placeholder organization (`@gbd/db/seed`) — phase 1 has no second one.
`e2e/fixtures/reports.ts` is the source of truth for what each state contains.

The `database` Playwright project (`setup/database.setup.ts`) deletes every fixture report in the
placeholder organization before either suite runs.

Screenshots and e2e share the catalogue, not its rows: every test mints its own report and deletes
it when it ends, so a behavioural spec is free to mutate what it created.

## Pending

`requireAuth`/`requireOrganizationAccess` guard every route below, but `identifyUser` always
resolves to one seeded user (see `auth.e2e.ts`) — there's no way yet to drive a bystander or
signed-out request through a real route to see its 401/403. Add one e2e per row once real
sign-in lands.

| Route | Unit coverage today |
| --- | --- |
| `POST orgs/:id/reports` (create) | `create-report.test.ts` |
| `GET orgs/:id/reports/:id` (view) | `load-report.test.ts` |
| `DELETE orgs/:id/reports/:id` | `delete-report.test.ts` |
