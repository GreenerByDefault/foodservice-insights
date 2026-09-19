# The sign-in form: what it needs before it mounts

## Context

`auth-ui` built the email-OTP sign-in form and mounted it nowhere — see
[`auth.md`](auth.md) § *What the sign-in form already is* for why it landed that way, and for the
seam (`BrowserAuth`, `browserAuth()`, `fakeBrowserAuth()`) that everything here works against.
`auth.md` PR 1 mounts it at `/sign-in` and takes the first screenshots of it.

An adversarial review against `cfa-web-app` (Eric's, finished auth) and `cfa-app` (the teammate's
fork, live in production) found seven confirmed defects. They divide cleanly:

- **Two dead Tailwind class families** in the vendored `input-otp` components. The class strings
  came from shadcn/**ui** (React), where the `input-otp` React library sets `data-active="true"`
  and the root element is the input. Under shadcn-**svelte** + bits-ui neither holds. shadcn-svelte
  generates a different string for the same component; `cfa-app` has that string and its ring
  renders.
- **Five ways the form dead-ends**, all of the same shape: a state machine that can enter a
  disabled state it has no edge out of. `cfa-app` guards three of them and has an explicit
  recovery stage for a fourth.

None of this is a regression against CFA — `cfa-app` shares the cached-rejection flaw, and both
CFA repos ship the same accessibility gap in their cell markup. It is the work that turns a
form that passes its tests into one that survives a bad afternoon in production.

`auth.md` is the plan for the feature; this is the plan for the form. When they disagree about
the form, this file is the newer one. Both defer to the code.

### What this is not

- **Findings that belong to `auth.md` PR 1, not here** — folded into that file by PR 2's last
  commit, not implemented here: `event.cookies.set` throwing
  `"after the response has been generated"` when `getUser()` rotates a token late in a streamed
  response (`cfa-app` `hooks.server.ts:359-377` catches and warns; the plan's `setAll` spec does
  not mention it), and `global: { fetch: event.fetch }` on the server client.
- **Pending-OTP persistence** — `cfa-app` keeps `{ email, createdAt }` in `sessionStorage` for an
  hour and restores the code stage on remount (`auth-flow.svelte:66-129`), so a reload does not
  cost the visitor a second code and a second cooldown. It is the one real UX feature CFA has and
  we do not. Out of scope: it needs a `restoring` stage held through hydration, and it changes
  what `sign-in.screenshot.ts` captures. Recorded under `auth.md` § Follow-ups.
- **`otp_disabled` (422)**, which GoTrue returns when `shouldCreateUser: false` meets an unknown
  address (`cfa-app` `auth-errors.ts:8-11`). Our first send always creates the user, so the only
  way to reach it is a user deleted between send and resend. The generic fallback is the right
  copy for that.
- **The `derived_inert` warnings** in `code-step.svelte.test.ts` — a separate investigation with
  its own handoff. PR 2's unmount guard may resolve them as a side effect; if it does, say so
  there rather than claiming it as this plan's work.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Fixing the dead `data-[active=true]` | Rewrite as `data-active:` (Tailwind v4 presence shorthand), 7 occurrences | bits-ui emits `data-active=""`. Presence is also what every other bits-ui component in `ui/` already keys on — `data-open:`, `data-inset:`, `data-disabled:`. `cell.isActive && '...'` is what shadcn-svelte generates and would work too, but it puts the styling decision in the markup where the rest of `ui/` keeps it in the class string |
| Re-vendoring from shadcn-svelte instead | Rejected | The two files carry deliberate local edits — `inputRef` for focus, the contiguous-group border treatment, no separator — and re-generating would discard them to fix two strings |
| The verified state | Stays sticky; every other control locks behind it | The comment at `code-step.svelte:23-25` already states the invariant. This enforces it rather than restating it |
| Recovering a verified-but-not-navigated session | A `stalled` state with a Try again that re-runs `onSignedIn()` | `cfa-app`'s `session` stage (`auth-flow.svelte:225-240`). The alternative — re-running `verifyOtp` — cannot work: GoTrue has spent the code |
| A rejected auth call | `try`/`catch` at each of the three call sites, mapped through `describeAuthError`'s fallback | The seam returns `{ error }` for everything Supabase classifies and throws for everything it does not. Both have to land the visitor somewhere they can act |
| The cached rejected import | `browserAuth()` clears `authPromise` on rejection | A missing env var is permanent and will fail again immediately; a chunk 404 after a deploy is not, and caching it means the visitor cannot sign in, or out, until they reload |
| Field ids | Derived from `$props.id()`; `FIELD` keeps supplying `name` | `auth.md` PR 3 mounts this same flow inside `error-page.svelte`. Two mounts on one page would collide on `id="email"` today. `apps/web/README.md` § Forms pins where the *name* comes from, and that is unchanged |

---

## PR 1 — The vendored OTP field renders what it claims to

A prefactor: `apps/web/src/lib/components/ui/input-otp/` only, no change to the flow.

- **`input-otp-slot.svelte`:** `data-[active=true]:` → `data-active:`, 7 occurrences. Verify by
  reading the DOM, not the CSS — bits-ui sets `data-active=""` on the focused cell and
  `data-inactive=""` on the rest. Until this lands, the active cell has no border, no ring and no
  `z-10`; the real `<input>` is styled `outline: transparent solid 0px` with transparent text and
  caret, so the blinking fake caret is the only focus indicator the field has.
- **`input-otp.svelte`:** `disabled:cursor-not-allowed` → `[&_input]:disabled:cursor-not-allowed`.
  The root is a `<div>`; bits-ui merges `restProps` into the descendant `<input>`, so the root is
  never `:disabled`. (`has-disabled:opacity-50` beside it is a `:has()` and already works.)
- **`input-otp-group.svelte`:** `aria-hidden="true"`. The six cells put the code's digits into the
  accessibility tree as loose text beside the input that already carries the value. Neither CFA
  repo does this — it is an improvement over both, not a port. `cellText()` in
  `code-step.svelte.test.ts` reads the DOM directly and is unaffected.
- **Test:** one case in a new `input-otp.svelte.test.ts` asserting the focused cell carries
  `data-active` and its siblings `data-inactive`. This is what the class string depends on and
  what a bits-ui upgrade would silently change; the rest of the primitive is bits-ui's contract and
  is not ours to re-test.

Once this lands, `code-step.svelte` can drop the per-`Slot` `aria-invalid` it passes only to drive
the group's `has-aria-invalid:` — or keep it with a line saying that is what it is for. It reads as
redundant with the `aria-invalid` already going to the input.

## PR 2 — The form cannot dead-end

Five states with no edge out, plus the docs that describe the form wrongly. Commit by commit:

1. **`browser.ts` stops caching a failure.** `authPromise ??= import(...)` holds a rejected promise
   forever, because a rejected promise is not nullish — so one chunk 404 after a deploy costs the
   visitor sign-in *and* sign-out until they reload. Clear `authPromise` in a `.catch` and rethrow.
   First test file for this module: the lazy load, that a second call reuses the client, and that a
   failure is not cached.
2. **The three call sites handle a throw.** `email-step.svelte:52`, `code-step.svelte:84` and
   `code-step.svelte:114` destructure `{ error }` from an awaited call with no `try`. The seam
   *rejects* when the dynamic import fails or the env vars are missing
   (`browser.ts:31`, `browser.ts:37`), so the state machine never leaves `sending`/`verifying`:
   field disabled, button disabled, no message, reload the only exit. A test per site, driving it
   from a `fakeBrowserAuth()` method set to `mockRejectedValue`.
3. **Resend and Change email lock behind a verify.** `handleResend` (`code-step.svelte:109`) guards
   only on `resend.status`, so once the 60s cooldown has elapsed — which is to say, for anyone who
   waited for their email — a click during `verifying` fires `signInWithOtp`, then writes
   `formState = { status: 'idle' }` and `code = ''`, racing the in-flight `verifyOtp` that writes
   `verified`/`failed` back over it. After `verified` the same click re-enables the field, which is
   precisely what the comment at lines 23-25 says must not happen. `cfa-app` derives one
   `requestInFlight` across both directions (`otp-form.svelte:71-73`); do the same and cover both
   buttons. Tests: resend refused during `verifying`, and refused after `verified`.
4. **A verified code that does not navigate has a way forward.** If `onSignedIn()` resolves without
   the server seeing the session — GoTrue unreachable on the next request and answering
   `auth.md`'s own 503, a cookie the server cannot read, `invalidateAll()` resolving with no
   redirect — the step sits on "Signing in…" with a disabled field forever, from a *successful*
   verification. Add a `stalled` state behind a timeout or a resolved-and-still-here check, with
   the copy and the Try again button `cfa-app` uses (`auth-flow.svelte:225-240`).
5. **Neither step writes state after unmount.** Both write `$state` post-await unconditionally;
   `cfa-app` tracks `isActive` and bails after every await (`otp-form.svelte:82-91, 131, 159`).
   Note in the commit whether this moves the `derived_inert` count in `code-step.svelte.test.ts`.
6. **Ids come from `$props.id()`.** `FIELD.email` and `FIELD.code` are hardcoded global DOM ids
   while the description and error ids beside them already use `$props.id()`. `auth.md` PR 3 mounts
   this flow inside `error-page.svelte`; two mounts on a page collide. `FIELD` keeps supplying
   `name`, which is what `apps/web/README.md` § Forms actually pins.
7. **Pin the Enter fallback with a test.** `handleSubmit` (`code-step.svelte:100-106`) is the only
   route forward if a value lands without `onComplete` seeing the transition, and it is the stated
   reason there is no submit button — and nothing tests it. It does work: bits-ui's
   `KEYS_TO_IGNORE` includes `Enter`, so the keydown is not prevented, and a form whose only
   field is text-like submits implicitly.
8. **`apps/web/README.md` § Forms.** It says a form has "a `<button type="submit">`" and that the
   browser blocks an invalid submit and focuses the first bad field. The code step has neither a
   submit button nor a `required` field — it completes itself, and Enter is the fallback. Per
   `AGENTS.md`, the README is the bug. Add the self-completing case.
9. **Fold the rest into `auth.md`.** Its Settled decisions still reads *"OTP input | Plain
   `<input inputmode="numeric" …>` | … no new dependency"*, which the branch replaced with
   bits-ui `PinInput` (`bits-ui` was already a dependency, so the *reason* survives — the decision
   does not). Add the two `cfa-app` server-hook details and pending-OTP persistence, all three
   described under § What this is not above, to PR 1's bullets and § Follow-ups respectively.

## Verification

`pnpm lint && pnpm check && pnpm test` from the repo root, per PR. While iterating,
`pnpm --filter @gbd/web test:unit` scoped to the file.

No screenshots to re-baseline: `/sign-in` still renders `StubNotice` until `auth.md` PR 1 makes
`identifyUser` read a real session, so the form draws nowhere a spec can photograph it. That is
also why PR 1's ring fix has to land *before* `sign-in-code.png` is ever taken — a baseline
captured over the dead class string would make the missing focus ring look intended.

Walk it by hand once with `pnpm dev`, which is the only way to see the two class fixes:

- Tab into the OTP field: the focused cell has a visible ring that moves with the caret.
- Stop the auth container (`docker stop supabase_auth_fsi-dev`) and enter a code: an error the
  visitor can act on, not a form frozen on "Signing in…".
- With the network throttled to offline after the page loads, submit an address: the same.
