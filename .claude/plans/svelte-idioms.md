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
`@sveltejs/kit/hooks` types all adopted. `svelte-autofixer` reports no issues in any of the 65
non-vendored `.svelte`/`.svelte.ts` files; its suggestions are heuristics ("an `$effect` calls a
function", "`bind:this` could be an attachment") and land on the sites in the table below plus
`upload-form.svelte`'s `bind:this`. What is left is two `$effect`s doing a job Svelte has a
dedicated API for, one element ref that does not need to exist, and one SvelteKit 3 capability the
app does not use yet.

`$effect` sites, and the verdict on each:

| Site | Does | Verdict |
| --- | --- | --- |
| `routes/+layout.svelte` (2nd effect) | `window.addEventListener('pageshow', …)` | **Change** — `<svelte:window onpageshow>` |
| `routes/(app)/…/reports/new/rejection-view.svelte` | Focuses the heading on mount via `bind:this` + `$state` | **Change** — `{@attach}` |
| `routes/+layout.svelte` (1st effect) | Sets `data-hydrated` once | Keep |
| `routes/+layout.svelte` (2nd effect, rest) | Supabase `onAuthStateChange` subscription | Keep — a real external subscription with teardown |
| `lib/components/confirm-action.svelte` | Resets `typedPhrase`/`actionState` when `open` goes false | Keep — see Decisions |
| `lib/components/auth/code-step.svelte` | Resend countdown `setInterval` | Keep — a timer, written from its callback |
| `lib/components/auth/code-step.svelte`, `email-step.svelte` | Focus the field on mount | Keep — the same ref is refocused from handlers, and the OTP input sits behind bits-ui's `inputRef`, where an attachment would not reach |
| `lib/polling/create-poller.svelte.ts` | Starts/stops the poll chain | Keep — a `.svelte.ts` cannot use `<svelte:document>`, and it is well covered |

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

## PR 1 — DOM wiring through Svelte's element APIs

- `routes/+layout.svelte`: move the `pageshow` listener out of the auth effect into
  `<svelte:window onpageshow={…} />`, still only in `supabase` mode — e.g.
  `const onPageShow = authMode() === 'supabase' ? refreshWhenRestoredByBack(() => location.reload()) : undefined`.
  The effect keeps the subscription and loses the `addEventListener`/`removeEventListener` pair.
  The comment explaining why a restored page reloads moves to the new handler.
- `reports/new/rejection-view.svelte`: drop `headingElement` and its `$effect`; put
  `{@attach (node) => node.focus()}` on the `<h2>`. Its comment moves with it.
- `reports/new/upload-form.svelte`: drop `formElement` and `bind:this`; `handleSubmit` takes
  `SubmitEvent & { currentTarget: HTMLFormElement }` and reads the form from
  `event.currentTarget` as its first line. `currentTarget` is null once dispatch ends, so it has to
  be captured before the first `await` — today's `new FormData(form)` already runs before one, but
  capturing at the top keeps that true if the handler grows. The `if (!form) return` guard goes.

Tests: `rejection-view.svelte.test.ts` already asserts the heading takes focus,
`upload-form.svelte.test.ts` submits the form, and `follow-session.test.ts` covers the `pageshow`
predicate; the new wiring is declarative.

## PR 2 — Full-page navigation after a new deploy

In `routes/+layout.svelte`, `beforeNavigate` from `$app/navigation` with `updated` from
`$app/state`, as in SvelteKit's `version` docs: when `updated.current`, the navigation will not
already unload the page, and it has a `to.url`, set `location.href` to it. Keep the decision pure
and tested the way `refreshWhenRestoredByBack` is — a small function in `src/lib/` (e.g.
`navigation/new-version.ts`) taking `{ updated, willUnload, to }` and returning the URL to load or
`null`, with a unit test per branch. If SvelteKit's `version.name` should be the commit rather than
the build timestamp, that is a `vite.config.ts` line in this PR — but the default works.

Out of scope, worth a line in the PR description: the poll clients (`poll-report.ts`,
`poll-reports.ts`) trust the wire shape as "from the same deploy", and a page left polling across a
deploy talks to the new server with the old client. Polls are plain `fetch`, so they do not feed
`updated`; this PR does not change that.

## Verification

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test`. While iterating, the touched
test file only, e.g.
`pnpm --filter @gbd/web test:unit -- 'src/routes/(app)/orgs/[organizationSlug=slug]/reports/new/rejection-view.svelte.test.ts'`.
Run `svelte-autofixer` on every `.svelte` file touched until it reports nothing.

Manual, with `pnpm dev:web` in `supabase` mode: sign out in a second tab, leave the first for
another site, come back with Back — the page reloads; in `placeholder` mode it does not. For PR 2,
`pnpm build` and run the server, open a page, rebuild and restart, refocus the tab, then click a
link — the network tab shows a document request rather than `__data.json`.
