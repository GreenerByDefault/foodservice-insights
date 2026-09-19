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
  onCodeSent: () => void;
}

let { auth, email = $bindable(), onCodeSent }: Props = $props();

type StepState = { status: 'idle' } | { status: 'sending' } | { status: 'failed'; message: string };

let formState: StepState = $state({ status: 'idle' });

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'sending') return;

  // `type="email"` lets through addresses valibot rejects — `a@b` has no dot — so this is a real
  // second gate, not a restatement of the markup.
  const parsed = v.safeParse(emailAddress, email);
  if (!parsed.success) {
    formState = { status: 'failed', message: 'Enter a valid email address.' };
    return;
  }
  email = parsed.output;

  formState = { status: 'sending' };
  // Sign-in and sign-up are one flow: anyone may create an organization, so an address we have
  // never seen is a new account, not a mistake to correct.
  const { error } = await auth.signInWithOtp({
    email: parsed.output,
    options: { shouldCreateUser: true },
  });

  if (error) {
    formState = { status: 'failed', message: describeAuthError(error) };
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
      id={FIELD.email}
      name={FIELD.email}
      type="email"
      autocomplete="email"
      maxlength={MAX_EMAIL_LENGTH}
      required
      bind:value={email}
    />
    <Field.Description>
      We'll email you a {OTP_LENGTH}-digit code. New here? This creates your account.
    </Field.Description>
    {#if formState.status === 'failed'}
      <Field.Error>{formState.message}</Field.Error>
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
