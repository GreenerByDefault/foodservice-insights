# @gbd/browser-testing

Playwright helpers shared by `apps/web/e2e` and `tests/e2e` — driving a page's fake clock
through its poll loop, and waiting for Svelte hydration before interacting with the page.

`./test-run` is a second export, for the two `scripts/test-run.ts` wrappers rather than specs:
`runAgainstFreshStack` gives a Playwright run its own database and blob-store bucket, and a hook
to start anything else the run needs before the browser does (`tests/e2e` uses it to spawn a
worker). Kept as a separate subpath so a spec importing the page helpers above doesn't pull in
`@gbd/db` and `@gbd/storage` along with them.
