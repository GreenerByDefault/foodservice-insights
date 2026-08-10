<!-- **Stub:** renders a placeholder. It will hold both steps of email OTP in one page — the
     address, then the six-digit code, kept in `$state`.
     Supabase is called from the browser — `signInWithOtp`, then `verifyOtp` — so no route of ours
     handles a credential and there is no callback route to receive a link. `@supabase/ssr` writes
     the cookie, `onAuthStateChange` fires `invalidateAll()`, and the server sees the session on the
     next load.
     Reached from the marketing page and from an invite email, which prefills `?email=`. A visitor
     turned away from a protected page arrives at `$lib/components/error-page.svelte` instead, which
     offers this same flow without sending them here. -->
<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-8">
  <h1 class="text-2xl font-semibold tracking-tight">Sign in</h1>

  <p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>
</main>
