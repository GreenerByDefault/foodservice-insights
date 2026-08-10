# @gbd/upload

Deciding whether an uploaded file is worth analysing. Shared verbatim by the browser and the
SvelteKit server, so the two cannot reach different verdicts about the same file — the client
runs this for the feedback, and the server runs it because the client's answer proves nothing security-wise.

`checkUploadBytes` is pure and synchronous. Keeping it that way is the whole point, so nothing
here may reach for a clock, the network, or a platform API that only one of the two runtimes has.
`tsconfig.json` enforces the Node half of that by leaving `@types/node` out.

> **Status:** this covers the file's bytes only — size, container formats, blankness. Reading it
> as a table is not implemented, so `bad_columns` and `csv_injection` exist in the database enum
> without anything producing them yet.
