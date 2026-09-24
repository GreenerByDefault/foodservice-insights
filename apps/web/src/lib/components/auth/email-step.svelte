<script lang="ts">
import * as v from 'valibot';
import type { BrowserAuth } from '$lib/auth/browser';
import { describeAuthError, FIELD, OTP_LENGTH } from '$lib/auth/sign-in';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import { emailAddress, MAX_EMAIL_LENGTH } from '$lib/forms/validation';

interface Props {
  auth: BrowserAuth;
  /** Bound, so returning here from the code step brings the address back with it. */
  email: string;
  /** True only when the visitor came back from the code step, where this field is what they asked
   * for. On first load the page heading is what should be read, not a field torn out of it. */
  focusOnMount: boolean;
  onCodeSent: () => void;
}

let { auth, email = $bindable(), focusOnMount, onCodeSent }: Props = $props();

type StepState = { status: 'idle' } | { status: 'sending' } | { status: 'failed'; message: string };

let formState: StepState = $state({ status: 'idle' });
let emailInputElement: HTMLInputElement | null = $state(null);

const fieldId = $props.id();
const descriptionId = `${fieldId}-description`;
const errorId = `${fieldId}-error`;

$effect(() => {
  if (focusOnMount) emailInputElement?.focus();
});

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'sending') return;

  // `type="email"` lets through addresses valibot rejects — `a@b` has no dot — so this is a real
  // second gate, not a restatement of the markup.
  const parsed = v.safeParse(emailAddress, email);
  if (!parsed.success) {
    formState = { status: 'failed', message: 'Enter a valid email address.' };
    emailInputElement?.focus();
    return;
  }
  email = parsed.output;

  formState = { status: 'sending' };
  // Sign-in and sign-up are one flow: anyone may create an organization, so an address we have
  // never seen is a new account, not a mistake to correct.
  let message: string | null;
  try {
    const { error } = await auth.signInWithOtp({
      email: parsed.output,
      options: { shouldCreateUser: true },
    });
    message = error && describeAuthError(error);
  } catch (cause) {
    // The seam rejects, rather than answering `{ error }`, when the client itself could not load.
    console.error('Could not send a sign-in code', cause);
    message = describeAuthError({});
  }

  if (message) {
    formState = { status: 'failed', message };
    emailInputElement?.focus();
    return;
  }
  formState = { status: 'idle' };
  onCodeSent();
}
</script>

<form onsubmit={handleSubmit} class="w-full space-y-8">
  <Field.Field>
    <Field.Label for={FIELD.email}>Email address</Field.Label>
    <Input
      bind:ref={emailInputElement}
      id={FIELD.email}
      name={FIELD.email}
      type="email"
      autocomplete="email"
      maxlength={MAX_EMAIL_LENGTH}
      required
      aria-invalid={formState.status === 'failed' || undefined}
      aria-describedby={formState.status === 'failed'
        ? `${descriptionId} ${errorId}`
        : descriptionId}
      bind:value={email}
    />
    <Field.Description id={descriptionId}>
      We'll email you a {OTP_LENGTH}-digit code. New here? This creates your account.
    </Field.Description>
    {#if formState.status === 'failed'}
      <Field.Error id={errorId}>{formState.message}</Field.Error>
    {/if}
  </Field.Field>

  <Button
    type="submit"
    disabled={formState.status === 'sending'}
    aria-busy={formState.status === 'sending'}
  >
    {formState.status === 'sending' ? 'Sending code…' : 'Send code'}
  </Button>
</form>
