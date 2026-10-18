<script lang="ts">
import { APP_NAME } from '@gbd/core';
import { refreshAll } from '$app/navigation';
import { browserAuth } from '#lib/auth/browser.js';
import { authMode } from '#lib/auth/mode.js';
import DisplayNameForm from '#lib/components/account/display-name-form.svelte';
import SignInFlow from '#lib/components/auth/sign-in-flow.svelte';
import SitePasswordForm from '#lib/components/auth/site-password-form.svelte';
import PageHeading from '#lib/components/page-heading.svelte';
import { describeError } from '#lib/errors/messages.js';
import { pageTitle } from '#lib/page-title.js';

interface Props {
  status: number;
  code?: App.Error['code'];
}

let { status, code }: Props = $props();

const presentation = $derived(describeError(status));
// Not a failure to explain, so it has no `describeError` copy.
const title = $derived(
  code === 'onboarding_required' ? `Welcome to ${APP_NAME}` : presentation.title,
);
</script>

<svelte:head>
  <title>{pageTitle(title)}</title>
  <!-- A failed request is not a page, so keep it out of the index and out of search results. -->
  <meta name="robots" content="noindex">
</svelte:head>

{#if code === 'onboarding_required'}
  <!-- The `(app)` gate's answer to a signed-in user with no name, so asked at the URL they wanted,
       the way a 401 signs them in: saving re-runs the loads and that page renders. -->
  <div class="flex w-full max-w-sm flex-col gap-4 self-center">
    <PageHeading>{title}</PageHeading>

    <DisplayNameForm initialName="" submitLabel="Continue" onSaved={refreshAll} />
  </div>
{:else if status === 401}
  <!-- Signing in here re-runs the loads, so the page that was asked for renders at its own URL:
       no redirect, no `?next=`. -->
  <div class="flex w-full max-w-sm flex-col gap-4 self-center">
    <PageHeading>{presentation.title}</PageHeading>
    <p class="text-muted-foreground">{presentation.body}</p>

    {#if authMode() === 'placeholder'}
      <SitePasswordForm onSignedIn={refreshAll} />
    {:else}
      <SignInFlow auth={browserAuth()} onSignedIn={refreshAll} />
    {/if}
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
