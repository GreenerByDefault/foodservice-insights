<script lang="ts">
import { onDestroy, tick } from 'svelte';
import { toast } from 'svelte-sonner';
import * as v from 'valibot';
import { refreshAll } from '$app/navigation';
import type { BrowserAuth } from '#lib/auth/browser.js';
import { describeAuthError, OTP_LENGTH } from '#lib/auth/sign-in.js';
import CodeStep from '#lib/components/auth/code-step.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';
import { emailAddress, MAX_EMAIL_LENGTH } from '#lib/forms/validation.js';

interface Props {
  // A prop, rather than a call to `browserAuth()`, so tests can fake it.
  auth: BrowserAuth;
  currentEmail: string;
}

let { auth, currentEmail }: Props = $props();

type SendState = { status: 'idle' } | { status: 'sending' } | { status: 'failed'; message: string };

// Seeded once and never re-synced, so the `refreshAll()` after a change cannot clobber an edit.
// svelte-ignore state_referenced_locally
let email = $state(currentEmail);
let step: 'email' | 'code' = $state('email');
let sendState: SendState = $state({ status: 'idle' });
/** On first render the field is one of several on the page, so it must not take focus. Back from
 * the code step, it is where the visitor just was. */
let returningFromCodeStep = $state(false);
let emailInputElement: HTMLInputElement | null = $state(null);

const fieldId = $props.id();
const descriptionId = `${fieldId}-description`;
const errorId = `${fieldId}-error`;

// A request can outlive the form — a navigation away mid-send — so every `await` is followed by
// this check.
let isMounted = true;
onDestroy(() => {
  isMounted = false;
});

$effect(() => {
  if (returningFromCodeStep) emailInputElement?.focus();
});

function fail(message: string) {
  sendState = { status: 'failed', message };
  emailInputElement?.focus();
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (sendState.status === 'sending') return;

  const parsed = v.safeParse(emailAddress, email);
  if (!parsed.success) {
    fail('Enter a valid email address.');
    return;
  }
  email = parsed.output;
  // GoTrue answers an update to the address the account already has as a success, and sends
  // nothing — which would leave the code step waiting for an email that never comes.
  if (parsed.output === currentEmail.toLowerCase()) {
    fail("That's already your email.");
    return;
  }

  sendState = { status: 'sending' };
  let message: string | null;
  try {
    const { error } = await auth.updateUser({ email: parsed.output });
    message = error && describeAuthError(error);
  } catch (cause) {
    console.error('Could not start an email change', cause);
    message = describeAuthError({});
  }
  if (!isMounted) return;

  if (message) {
    fail(message);
    return;
  }
  sendState = { status: 'idle' };
  returningFromCodeStep = true;
  step = 'code';
}

async function finishChange() {
  step = 'email';
  // Leaves the code step before refreshing rather than after: the change is done whatever the
  // refresh does, and a step still mounted when this resolves reads that as a stall.
  await tick();
  toast.success(`Changed your email to ${email}`);
  await refreshAll();
}
</script>

{#if step === 'email'}
  <form onsubmit={handleSubmit} class="flex flex-col gap-4">
    <Field.Field>
      <Field.Label for={fieldId}>Email</Field.Label>
      <Input
        bind:ref={emailInputElement}
        id={fieldId}
        type="email"
        autocomplete="email"
        maxlength={MAX_EMAIL_LENGTH}
        required
        aria-invalid={sendState.status === 'failed' || undefined}
        aria-describedby={sendState.status === 'failed'
          ? `${descriptionId} ${errorId}`
          : descriptionId}
        bind:value={email}
      />
      <Field.Description id={descriptionId}>
        To change it, we'll email a {OTP_LENGTH}-digit code to the new address.
      </Field.Description>
      {#if sendState.status === 'failed'}
        <Field.Error id={errorId}>{sendState.message}</Field.Error>
      {/if}
    </Field.Field>

    <Button
      type="submit"
      variant="outline"
      class="self-start"
      disabled={sendState.status === 'sending'}
      aria-busy={sendState.status === 'sending'}
    >
      {sendState.status === 'sending' ? 'Sending code…' : 'Change email'}
    </Button>
  </form>
{:else}
  <div class="flex flex-col gap-4">
    <CodeStep
      {auth}
      purpose="email-change"
      {email}
      onVerified={finishChange}
      onChangeEmail={() => (step = 'email')}
    />
  </div>
{/if}
