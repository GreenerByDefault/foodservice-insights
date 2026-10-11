# @gbd/browser-testing

Playwright helpers shared by `apps/web/e2e` and `tests/e2e` — driving a page's fake clock
through its poll loop, and waiting for Svelte hydration before interacting with the page.

`./fixtures` is the extended Playwright `test` both suites build on — a signed-in identity, and
an organization it administers. `./identity.ts` behind it is where both are made, for either
`PUBLIC_AUTH_MODE`: the one placeholder user, or a GoTrue user signed in per test.

Two more exports are for the harness rather than specs. `./test-run` is for the two
`scripts/test-run.ts` wrappers: `runAgainstFreshStack` gives a Playwright run its own database,
blob-store bucket and identity, and a hook to start anything else the run needs before the browser
does (`tests/e2e` uses it to spawn a worker). `./playwright-config` is what both
`playwright.config.ts` files build on: the port and base URL that run was assigned.

Each is a separate subpath so a spec importing the page helpers above doesn't pull in `@gbd/db`
and `@gbd/storage` along with them — and, more sharply, so a `playwright.config.ts` never loads
`@gbd/db/env`, which opens a connection pool at import time.
