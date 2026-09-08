# @gbd/browser-testing

Playwright helpers shared by `apps/web/e2e` and `tests/e2e` — driving a page's fake clock
through its poll loop, and waiting for Svelte hydration before interacting with the page.

`./fixtures` is the extended Playwright `test` both suites build on — the run's signed-in
identity, and an organization it administers. `./identity.ts` behind it is the only place either
suite refers to the phase-one placeholder user, so real sign-in has one file to replace.

`./test-run` is a third export, for the two `scripts/test-run.ts` wrappers rather than specs:
`runAgainstFreshStack` gives a Playwright run its own database, blob-store bucket and identity,
and a hook to start anything else the run needs before the browser does (`tests/e2e` uses it to
spawn a worker).

Each is a separate subpath so a spec importing the page helpers above doesn't pull in `@gbd/db`
and `@gbd/storage` along with them — and, more sharply, so a `playwright.config.ts` never loads
`@gbd/db/env`, which opens a connection pool at import time.
