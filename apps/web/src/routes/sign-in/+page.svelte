<script lang="ts">
import { APP_NAME } from '@gbd/core';
import { invalidateAll } from '$app/navigation';
import { browserAuth } from '$lib/auth/browser';
import SignInFlow from '$lib/components/auth/sign-in-flow.svelte';
import PageHeading from '$lib/components/page-heading.svelte';
import PublicShell from '$lib/components/public-shell.svelte';
</script>

<svelte:head>
  <title>Sign in · {APP_NAME}</title>
</svelte:head>

<!-- Supabase is called from the browser — `signInWithOtp`, then `verifyOtp` — so no route of ours
     handles a credential and there is no callback route to receive a link.
     Reached from the marketing page and from an invite email. A visitor turned away from a
     protected page arrives at `$lib/components/error-page.svelte` instead, which will offer this
     same flow without sending them here. -->
<PublicShell>
  <div class="flex w-full max-w-sm flex-col gap-4 self-center">
    <PageHeading>Sign in</PageHeading>

    <SignInFlow auth={browserAuth()} onSignedIn={invalidateAll} />
  </div>
</PublicShell>
