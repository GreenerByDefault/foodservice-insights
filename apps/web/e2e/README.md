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
| `lib/` | Helpers a spec imports. No tests, no side effects at import. |
| `fixtures/` | The report-state catalogue and the extended `test` that commits and cleans up a report. |
| `setup/` | Getting the containerized browser up, taking it down, and optimizing screenshots afterward. Not tests of the app. |
| `__screenshots__/` | The committed PNGs, nested to match the spec that captures them, and by viewport. |
| everything else | Specs, both suites. |

**Specs stay flat until a feature has two of them, then that feature gets a folder** holding both
its suites.

`__screenshots__/` mirrors that same nesting (`snapshotPathTemplate` in
[`../playwright.config.ts`](../playwright.config.ts) keys it off the spec's own directory), so a
shot's name only has to be unique within its feature — `reports/failed.png`, not
`reports-failed.png`. It's still browsed as a gallery, one folder per feature.

Every spec is captured at each viewport in [`lib/viewports.ts`](lib/viewports.ts). The widest keeps
the bare name; each narrower one nests under a directory named for itself, so browsing a feature's
own folder still shows one canonical image per screen.

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

**A screen with real layout gets a screenshot; a screen without one gets nothing until it has.**
The stub routes are the ones to leave alone: there is nothing to see in an `<h1>` and a `<p>`, and
the instinct to cover them with a cheap property assertion instead is what
`layout.e2e.ts` was, before narrow-width captures replaced it. Assert directly only for a defect a
screenshot genuinely cannot see — one that's cut off rather than merely ugly.

## Database state

Most fixtures live in the placeholder organization (`@gbd/db/seed`). `e2e/fixtures/reports.ts` is
the source of truth for what each report state contains.

There's no shared reset: every test mints its own report via the `reports` fixture
(`e2e/fixtures/test.ts`) and deletes it when it ends, whether it passed or failed. Screenshots and
e2e share the catalogue of states, not any rows, so a behavioural spec is free to mutate what it
created without affecting another test.

A spec that needs to control an organization's *entire* contents — rather than one report of its
own — grants the placeholder user membership in a second, dedicated organization for the test's
duration instead. `auth.e2e.ts` no longer assumes the placeholder user belongs to exactly one
organization, so doing this does not race that spec the way it once did.

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
