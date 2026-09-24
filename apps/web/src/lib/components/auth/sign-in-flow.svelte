<script lang="ts">
import type { BrowserAuth } from '$lib/auth/browser';
import CodeStep from './code-step.svelte';
import EmailStep from './email-step.svelte';

interface Props {
  // This is a prop, rather than call to `browserAuth()`, so tests can mock it.
  auth: BrowserAuth;
  /** What to do once the session cookie exists. An `invalidateAll()`, so the server sees the
   * session and its own redirect takes over. */
  onSignedIn: () => Promise<void>;
}

let { auth, onSignedIn }: Props = $props();

// Held here, not in the step, so "Change email" returns to a filled-in field.
let email = $state('');
let step: 'email' | 'code' = $state('email');
// Swapping one step for the other leaves focus on the `<body>`, so each step takes it on arrival.
// The email step is the exception on first render, where it *is* the page rather than a step
// moved to, so it only claims focus once the visitor has been past it.
let hasReachedCodeStep = $state(false);
</script>

{#if step === 'email'}
  <EmailStep
    {auth}
    bind:email
    returningFromCodeStep={hasReachedCodeStep}
    onCodeSent={() => {
      hasReachedCodeStep = true;
      step = 'code';
    }}
  />
{:else}
  <CodeStep {auth} {email} {onSignedIn} onChangeEmail={() => (step = 'email')} />
{/if}
