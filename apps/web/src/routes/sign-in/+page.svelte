<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import PublicShell from '$lib/components/public-shell.svelte';
import StubNotice from '$lib/components/stub-notice.svelte';
</script>

<!-- **Stub:** renders a placeholder. `$lib/components/auth/sign-in-flow.svelte` already holds both
     steps of email OTP, ready to mount here — but until `identifyUser` reads a real session, every
     request arrives signed in as the placeholder user and the `load` below redirects away, so
     mounting it now would put a form behind a door nobody can open.
     Supabase is called from the browser — `signInWithOtp`, then `verifyOtp` — so no route of ours
     handles a credential and there is no callback route to receive a link. `@supabase/ssr` writes
     the cookie, `onAuthStateChange` fires `invalidateAll()`, and the server sees the session on the
     next load.
     Reached from the marketing page and from an invite email, which prefills `?email=`. A visitor
     turned away from a protected page arrives at `$lib/components/error-page.svelte` instead, which
     offers this same flow without sending them here. -->
<PublicShell>
  <PageHeading>Sign in</PageHeading>

  <StubNotice />
</PublicShell>
