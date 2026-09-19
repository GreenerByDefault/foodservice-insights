<script lang="ts">
import type { BrowserAuth } from '$lib/auth/browser';
import { describeAuthError, FIELD, OTP_LENGTH, RESEND_COOLDOWN_S } from '$lib/auth/sign-in';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';

interface Props {
  auth: BrowserAuth;
  email: string;
  onSignedIn: () => Promise<void>;
  onChangeEmail: () => void;
}

let { auth, email, onSignedIn, onChangeEmail }: Props = $props();

const CODE_PATTERN = `[0-9]{${OTP_LENGTH}}`;

type StepState =
  | { status: 'idle' }
  | { status: 'verifying' }
  | { status: 'failed'; message: string }
  /** Held after `onSignedIn` resolves too: that call navigates, and re-enabling the form during
   * the navigation would invite a second `verifyOtp` with a code GoTrue has already spent. */
  | { status: 'verified' };

type ResendState =
  | { status: 'waiting'; remainingSeconds: number }
  | { status: 'ready' }
  | { status: 'sending' }
  | { status: 'failed'; message: string };

let formState: StepState = $state({ status: 'idle' });
let resend: ResendState = $state({ status: 'waiting', remainingSeconds: RESEND_COOLDOWN_S });
let code = $state('');

// Read through a `$derived` rather than from `resend` directly: the effect would otherwise depend
// on the whole of `resend` and tear its own interval down and back up on every tick.
const isCountingDown = $derived(resend.status === 'waiting');

$effect(() => {
  if (!isCountingDown) return;
  const interval = setInterval(() => {
    if (resend.status !== 'waiting') return;
    resend =
      resend.remainingSeconds <= 1
        ? { status: 'ready' }
        : { status: 'waiting', remainingSeconds: resend.remainingSeconds - 1 };
  }, 1000);
  return () => clearInterval(interval);
});

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'verifying' || formState.status === 'verified') return;

  formState = { status: 'verifying' };
  const { error } = await auth.verifyOtp({ email, token: code.trim(), type: 'email' });

  if (error) {
    formState = { status: 'failed', message: describeAuthError(error) };
    return;
  }
  formState = { status: 'verified' };
  await onSignedIn();
}

async function handleResend() {
  if (resend.status === 'waiting' || resend.status === 'sending') return;

  resend = { status: 'sending' };
  // `false`, unlike the first send: this address has already been sent a code, so creating a user
  // here could only mean the visitor changed the address out from under us.
  const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } });

  if (error) {
    resend = { status: 'failed', message: describeAuthError(error) };
    return;
  }
  code = '';
  formState = { status: 'idle' };
  resend = { status: 'waiting', remainingSeconds: RESEND_COOLDOWN_S };
}
</script>

<form onsubmit={handleSubmit} class="w-full space-y-8">
  <Field.Field>
    <Field.Label for={FIELD.code}>Sign-in code</Field.Label>
    <Input
      id={FIELD.code}
      name={FIELD.code}
      inputmode="numeric"
      autocomplete="one-time-code"
      pattern={CODE_PATTERN}
      maxlength={OTP_LENGTH}
      required
      class="max-w-40 font-mono tracking-[0.4em]"
      bind:value={code}
    />
    <Field.Description>We sent a code to {email}. It expires shortly.</Field.Description>
    {#if formState.status === 'failed'}
      <Field.Error>{formState.message}</Field.Error>
    {/if}
  </Field.Field>

  <Button
    type="submit"
    disabled={formState.status === 'verifying' || formState.status === 'verified'}
    aria-busy={formState.status === 'verifying'}
  >
    {formState.status === 'idle' || formState.status === 'failed' ? 'Sign in' : 'Signing in…'}
  </Button>
</form>

<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
  <Button
    variant="link"
    class="px-0"
    onclick={handleResend}
    disabled={resend.status === 'waiting' || resend.status === 'sending'}
  >
    {#if resend.status === 'waiting'}
      Send a new code in {resend.remainingSeconds}s
    {:else if resend.status === 'sending'}
      Sending…
    {:else}
      Send a new code
    {/if}
  </Button>
  <Button variant="link" class="px-0" onclick={onChangeEmail}>Change email</Button>
</div>

{#if resend.status === 'failed'}
  <p role="alert" class="text-sm text-destructive">{resend.message}</p>
{/if}
