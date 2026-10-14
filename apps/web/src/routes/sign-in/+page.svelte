<script lang="ts">
import { refreshAll } from '$app/navigation';
import { browserAuth } from '#lib/auth/browser.js';
import { authMode } from '#lib/auth/mode.js';
import SignInFlow from '#lib/components/auth/sign-in-flow.svelte';
import SitePasswordForm from '#lib/components/auth/site-password-form.svelte';
import PageHeading from '#lib/components/page-heading.svelte';
import PublicShell from '#lib/components/public-shell.svelte';
import { pageTitle } from '#lib/page-title.js';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Sign in')}</title>
</svelte:head>

<!-- In `supabase` mode, Supabase is called from the browser — `signInWithOtp`, then `verifyOtp` —
     so no route of ours handles that credential and there is no callback route to receive a link.
     Reached from the marketing page and from an invite email. A visitor turned away from a
     protected page never comes here: `#lib/components/error-page.svelte` offers them this same
     flow in place. -->
<PublicShell>
  <div class="flex w-full max-w-sm flex-col gap-4 self-center">
    <PageHeading>Sign in</PageHeading>

    {#if authMode() === 'placeholder'}
      <SitePasswordForm onSignedIn={refreshAll} />
    {:else}
      <SignInFlow auth={browserAuth()} initialEmail={data.initialEmail} onSignedIn={refreshAll} />
    {/if}
  </div>
</PublicShell>
