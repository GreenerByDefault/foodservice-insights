# Svelte idioms

## Context

An audit of `apps/web` against the vendored `svelte-core-bestpractices` skill, the Svelte MCP
docs, and the SvelteKit 3 migration guide, after the SvelteKit 3 upgrade (#438). Form actions and
remote functions are out of scope by decision (`apps/web/README.md` § Routes), as is revisiting
the poll-over-`invalidate()` design that README rejects.

The codebase is already in good shape. Runes only, no legacy syntax (`on:`, `<slot>`,
`$app/stores`, `export let`, `class:`), `$app/state` throughout, `PageProps`/`LayoutProps`, keyed
`{#each}`, writable `$derived` for the poll-owned page copies, discriminated-union state,
`$props.id()` for ids, and SvelteKit 3's `defineParams`, `defineEnvVars`, `#lib`, `refreshAll`, and
`@sveltejs/kit/hooks` types all adopted. The `pageshow` listener in `routes/+layout.svelte` is a
`<svelte:window onpageshow>` handler, and `rejection-view.svelte` focuses its heading with an
`{@attach}`. What is left is one SvelteKit 3 capability the app does not use yet.

`svelte-autofixer` still raises heuristics ("an `$effect` calls a function") on the `$effect`s
below. Each was weighed and kept:

| Site | Does | Why it stays |
| --- | --- | --- |
| `routes/+layout.svelte` (1st effect) | Sets `data-hydrated` once | — |
| `routes/+layout.svelte` (2nd effect) | Supabase `onAuthStateChange` subscription | A real external subscription with teardown |
| `lib/components/confirm-action.svelte` | Resets `typedPhrase`/`actionState` when `open` goes false | See Decisions |
| `lib/components/auth/code-step.svelte` | Resend countdown `setInterval` | A timer, written from its callback |
| `lib/components/auth/code-step.svelte`, `email-step.svelte` | Focus the field on mount | The same ref is refocused from handlers, and the OTP input sits behind bits-ui's `inputRef`, where an attachment would not reach |
| `lib/polling/create-poller.svelte.ts` | Starts/stops the poll chain | A `.svelte.ts` cannot use `<svelte:document>`, and it is well covered |

## Decisions

- **Accepted: replace an `$effect` only where Svelte names a better tool for that exact job** —
  `<svelte:window>` over `addEventListener`, an attachment over `bind:this` + effect for a one-shot
  DOM call. Effects that are genuinely subscriptions or timers stay.
- **Accepted: a new deployment turns the next client-side navigation into a full page load.**
  SvelteKit 3 now sets `updated.current` on its own — on data responses, on tab focus/visibility,
  and on an hourly poll — but does nothing with it unless the app does. The `beforeNavigate`
  pattern is the one SvelteKit's own `version` docs give.
- **Considered, not done: moving `ConfirmAction`'s reset out of its `$effect`** — the one effect
  here that writes state. bits-ui's `onOpenChangeComplete(false)` is the obvious replacement, but
  `PresenceManager` drops that callback when the dialog is reopened before its exit animation
  ends, and then a stale typed phrase pre-unlocks delete-organization's confirm button — the exact
  hazard the effect's comment names. `onOpenChange` misses a caller writing the bound `open`, and
  moving the state into a child of `AlertDialogContent` has the same reopen gap. The effect is the
  only version that resets on every close.
- **Considered, not done: `resolve()` from `$app/paths` in `src/lib/hrefs.ts`** for route-checked
  URLs. `hrefs.ts` feeds `load` data, poll JSON, and API calls as well as markup, and `resolve()`
  can return a base-relative path during server rendering. The type check is not worth that risk
  while e2e covers every route.
- **Considered, not done: `$state.raw` for the discriminated-union form states.** They are only
  ever reassigned, but they are a few fields each; the skill reserves `$state.raw` for large
  objects, and a raw object silently ignores a mutation someone later writes.
- **Considered, not done: context (`createContext`) instead of passing `organizationSlug` /
  `reportId` down to the delete, cancel, and member-action buttons.** Two levels of explicit props
  keep each leaf component renderable in a test without a provider.

## PR 1 — Full-page navigation after a new deploy

In `routes/+layout.svelte`, `beforeNavigate` from `$app/navigation` with `updated` from
`$app/state`, as in SvelteKit's `version` docs: when `updated.current`, the navigation will not
already unload the page, and it has a `to.url`, set `location.href` to it. Keep the decision pure
and tested the way `refreshWhenRestoredByBack` (`lib/auth/follow-session.ts`) is — a small function in `src/lib/` (e.g.
`navigation/new-version.ts`) taking `{ updated, willUnload, to }` and returning the URL to load or
`null`, with a unit test per branch. If SvelteKit's `version.name` should be the commit rather than
the build timestamp, that is a `vite.config.ts` line in this PR — but the default works.

Out of scope, worth a line in the PR description: the poll clients (`poll-report.ts`,
`poll-reports.ts`) trust the wire shape as "from the same deploy", and a page left polling across a
deploy talks to the new server with the old client. Polls are plain `fetch`, so they do not feed
`updated`; this PR does not change that.

## Verification

From the repo root: `pnpm lint && pnpm check && pnpm test`. While iterating, the new unit test
only, via `pnpm --filter @gbd/web test:unit -- <path>`. Run `svelte-autofixer` on
`routes/+layout.svelte` until it reports no issues beyond the subscription effect's heuristics.

Manual: `pnpm build` and run the server, open a page, rebuild and restart, refocus the tab, then
click a link — the network tab shows a document request rather than `__data.json`.
