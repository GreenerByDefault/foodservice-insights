# Sign-in form

## Context

The `auth-ui` branch holds the whole sign-in form — the Supabase browser client, both OTP steps,
the flow that joins them, and their component tests — about 1,370 lines across 23 files, 910 of
them the three components and their tests. That is too big to review as one PR, so it lands as
three stacked PRs, each of which changes nothing a user can see: nothing mounts the form until
`auth.md`'s PR 1 switches on Supabase Auth.

`auth.md` on the branch already describes the form as landed (§ What the sign-in form already is).
That diff is kept out of PRs 1 and 2 and folded in with `/plan-advance` as each lands, rather than
rebased through the stack.

## PR 1 — Supabase browser client

About 280 lines, 100 of them lockfile.

- Catalog entries in `pnpm-workspace.yaml`, `apps/web/package.json` dependencies,
  `pnpm-lock.yaml`.
- `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.example`, `.env.test`, and
  `turbo.json`.
- `AUTH_COOKIE_NAME` in `packages/core/src/index.ts`.
- `apps/web/src/lib/auth/browser.ts` and `browser.test.ts`.

Stands alone. The code worth reviewing — the lazy load, not caching a failed load,
`autoRefreshToken: false`, the SSR guard — would drown next to 900 lines of Svelte, and `auth.md`'s
server hook needs the deps, env vars, and cookie name anyway. `testing/fake.ts` stays out: no test
would use it yet.

## PR 2 — Email step

About 290 lines.

- `apps/web/src/lib/auth/sign-in.ts` and `sign-in.test.ts`.
- `apps/web/src/lib/auth/testing/fake.ts`.
- `apps/web/src/lib/components/auth/email-step.svelte` and its test.

The fake's first consumer. Establishes the patterns — form conventions, error mapping, the unmount
guard — before the harder step.

## PR 3 — Code step and flow

About 700 lines.

- `code-step.svelte` and its test (600 of the lines).
- `sign-in-flow.svelte` and its test.
- The two comment additions in `$lib/components/ui/input-otp/`.
- The "form that completes itself" paragraph in `apps/web/README.md` § Forms, and the updated stub
  comment in `routes/sign-in/+page.svelte`.
- The remaining `.claude/plans/auth.md` edits, after which this file is deleted.

The code step is the dense part — cooldown, locked controls, the Enter fallback — and gets a review
of its own. If three PRs is one too many, PR 2 folds into this one; PR 1 is the split that buys the
most.
