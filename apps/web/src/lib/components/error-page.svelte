<script lang="ts">
import { invalidateAll } from '$app/navigation';
import { browserAuth } from '#lib/auth/browser.js';
import SignInFlow from '#lib/components/auth/sign-in-flow.svelte';
import PageHeading from '#lib/components/page-heading.svelte';
import { describeError } from '#lib/errors/messages.js';

interface Props {
  status: number;
}

let { status }: Props = $props();

const presentation = $derived(describeError(status));
</script>

<svelte:head>
  <title>{presentation.title}</title>
  <!-- A failed request is not a page, so keep it out of the index and out of search results. -->
  <meta name="robots" content="noindex">
</svelte:head>

{#if status === 401}
  <!-- Signing in here re-runs the loads, so the page that was asked for renders at its own URL:
       no redirect, no `?next=`. No mode check — in `placeholder` nothing is ever signed out. -->
  <div class="flex w-full max-w-sm flex-col gap-4 self-center">
    <PageHeading>{presentation.title}</PageHeading>
    <p class="text-muted-foreground">{presentation.body}</p>

    <SignInFlow auth={browserAuth()} onSignedIn={invalidateAll} />
  </div>
{:else}
  <!-- No calls to action yet, deliberately. The 5xx cases want a retry plus somewhere to report
       the failure, which needs decisions we have not made. A per-failure id belongs with that —
       until a user is told to quote it, `handleError` finding its own log line by timestamp and
       user is enough. -->
  <div class="flex flex-col items-start gap-3">
    <h1 class="text-3xl font-semibold tracking-tight">{presentation.title}</h1>
    <p class="max-w-prose text-muted-foreground">{presentation.body}</p>

    {#if presentation.showStatus}
      <p class="text-sm text-muted-foreground">Error {status}</p>
    {/if}
  </div>
{/if}
