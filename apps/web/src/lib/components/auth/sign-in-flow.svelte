<script lang="ts">
import { onMount } from 'svelte';
import type { BrowserAuth } from '#lib/auth/browser.js';
import { forgetPendingCode, readPendingCode, rememberPendingCode } from '#lib/auth/pending-code.js';
import CodeStep from './code-step.svelte';
import EmailStep from './email-step.svelte';

interface Props {
  // This is a prop, rather than call to `browserAuth()`, so tests can mock it.
  auth: BrowserAuth;
  /** An address to start with, from an invite link's `?email=`. */
  initialEmail?: string | null;
  /** What to do once the session cookie exists. A `refreshAll()`, so the server sees the
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

// After hydration rather than during SSR, which cannot see the tab's storage. So a reload shows the
// email step for a frame before the code step replaces it; the alternative, a placeholder until
// hydration, would cost every signed-out visitor the form to spare the rare one restoring a code.
onMount(() => {
  const pending = readPendingCode();
  // An invite link naming someone else is the newer intent.
  if (pending === null || (initialEmail !== null && initialEmail !== pending)) return;
  email = pending;
  returningFromCodeStep = true;
  step = 'code';
});
</script>

{#if step === 'email'}
  <EmailStep
    {auth}
    bind:email
    {returningFromCodeStep}
    onCodeSent={() => {
      rememberPendingCode(email);
      returningFromCodeStep = true;
      step = 'code';
    }}
  />
{:else}
  <CodeStep
    {auth}
    purpose="sign-in"
    {email}
    onVerified={() => {
      forgetPendingCode();
      return onSignedIn();
    }}
    onChangeEmail={() => {
      forgetPendingCode();
      step = 'email';
    }}
  />
{/if}
