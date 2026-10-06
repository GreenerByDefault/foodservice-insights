<script lang="ts">
import type { BrowserAuth } from '#lib/auth/browser.js';
import CodeStep from './code-step.svelte';
import EmailStep from './email-step.svelte';

interface Props {
  // This is a prop, rather than call to `browserAuth()`, so tests can mock it.
  auth: BrowserAuth;
  /** An address to start with, from an invite link's `?email=`. */
  initialEmail?: string | null;
  /** What to do once the session cookie exists. An `invalidateAll()`, so the server sees the
   * session and its own redirect takes over. */
  onSignedIn: () => Promise<void>;
}

let { auth, initialEmail = null, onSignedIn }: Props = $props();

// Held here, not in the step, so "Change email" returns to a filled-in field. Seeded once from
// `initialEmail` and never re-synced: the visitor may already be editing it.
// svelte-ignore state_referenced_locally
let email = $state(initialEmail ?? '');
let step: 'email' | 'code' = $state('email');
let returningFromCodeStep = $state(false);
</script>

{#if step === 'email'}
  <EmailStep
    {auth}
    bind:email
    {returningFromCodeStep}
    onCodeSent={() => {
      returningFromCodeStep = true;
      step = 'code';
    }}
  />
{:else}
  <CodeStep {auth} {email} {onSignedIn} onChangeEmail={() => (step = 'email')} />
{/if}
