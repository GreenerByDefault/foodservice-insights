<script lang="ts">
import { REGEXP_ONLY_DIGITS } from 'bits-ui';
import { tick } from 'svelte';
import type { BrowserAuth } from '$lib/auth/browser';
import { describeAuthError, FIELD, OTP_LENGTH, RESEND_COOLDOWN_S } from '$lib/auth/sign-in';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import * as InputOTP from '$lib/components/ui/input-otp';

interface Props {
  auth: BrowserAuth;
  email: string;
  onSignedIn: () => Promise<void>;
  onChangeEmail: () => void;
}

let { auth, email, onSignedIn, onChangeEmail }: Props = $props();

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
let codeInputElement: HTMLInputElement | null = $state(null);

const fieldId = $props.id();
const descriptionId = `${fieldId}-description`;
const errorId = `${fieldId}-error`;

// A function, not an inline comparison: read straight off `formState` here, TypeScript narrows it
// to the initialiser it can see above and calls every other status unreachable.
function isVerifyingOrDone(state: StepState): boolean {
  return state.status === 'verifying' || state.status === 'verified';
}

const isBusy = $derived(isVerifyingOrDone(formState));
const hasFullCode = $derived(code.length === OTP_LENGTH);

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

// Taking the code is the whole of this step, and the OS only offers a copied code to the field
// that already has focus — so arriving here without it would cost the visitor the autofill.
$effect(() => {
  codeInputElement?.focus();
});

/** Digits only. A code lifted out of an email arrives wrapped in whatever surrounded it — a
 * leading space, a trailing newline, the hyphens some senders break the digits with. `pattern`
 * only judges the result, so without this the whole paste is dropped and nothing appears. */
function keepDigits(text: string): string {
  return text.replaceAll(/\D/g, '');
}

async function submitCode() {
  if (isBusy || !hasFullCode) return;

  formState = { status: 'verifying' };
  let message: string | null;
  try {
    const { error } = await auth.verifyOtp({ email, token: code, type: 'email' });
    message = error && describeAuthError(error);
  } catch (cause) {
    // The seam rejects, rather than answering `{ error }`, when the client itself could not load.
    console.error('Could not verify a sign-in code', cause);
    message = describeAuthError({});
  }

  if (message) {
    formState = { status: 'failed', message };
    // Cleared, not left in place, even when nothing judged the code: a full field has no room for
    // the next paste to land in, and bits-ui re-runs `onComplete` for a full value whenever its
    // effect re-runs — so a kept code would retry a failing call in a loop.
    code = '';
    // The field is `disabled` while verifying, and a disabled input cannot take focus.
    await tick();
    codeInputElement?.focus();
    return;
  }
  formState = { status: 'verified' };
  await onSignedIn();
}

/** The fallback behind `onComplete`. Nothing renders a submit button, but a form holding a single
 * field still submits on Enter — which is the only way forward if a value ever lands without
 * `onComplete` seeing the transition into it, as some password managers contrive to do. */
function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  void submitCode();
}

async function handleResend() {
  if (resend.status === 'waiting' || resend.status === 'sending') return;

  resend = { status: 'sending' };
  // `false`, unlike the first send: this address has already been sent a code, so creating a user
  // here could only mean the visitor changed the address out from under us.
  let message: string | null;
  try {
    const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    message = error && describeAuthError(error);
  } catch (cause) {
    console.error('Could not resend a sign-in code', cause);
    message = describeAuthError({});
  }

  if (message) {
    resend = { status: 'failed', message };
    return;
  }
  code = '';
  formState = { status: 'idle' };
  resend = { status: 'waiting', remainingSeconds: RESEND_COOLDOWN_S };
  codeInputElement?.focus();
}
</script>

<form onsubmit={handleSubmit} class="w-full space-y-4">
  <Field.Field>
    <Field.Label for={FIELD.code}>Sign-in code</Field.Label>
    <InputOTP.Root
      inputId={FIELD.code}
      name={FIELD.code}
      maxlength={OTP_LENGTH}
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={keepDigits}
      onComplete={() => void submitCode()}
      disabled={isBusy}
      aria-invalid={formState.status === 'failed' || undefined}
      aria-describedby={formState.status === 'failed'
        ? `${descriptionId} ${errorId}`
        : descriptionId}
      bind:inputRef={codeInputElement}
      bind:value={code}
    >
      {#snippet children({ cells })}
        <InputOTP.Group>
          {#each cells as cell, index (index)}
            <InputOTP.Slot {cell} aria-invalid={formState.status === 'failed' || undefined} />
          {/each}
        </InputOTP.Group>
      {/snippet}
    </InputOTP.Root>
    <Field.Description id={descriptionId}>
      We sent a code to {email}. It expires shortly. We'll sign you in as soon as you enter it.
    </Field.Description>
    {#if formState.status === 'failed'}
      <Field.Error id={errorId}>{formState.message}</Field.Error>
    {/if}
  </Field.Field>

  <!-- Rendered whatever the state, rather than inside the `{#if}`: a live region is only
       announced if the screen reader was already watching the node when its text changed, so one
       that appears along with its message is read by nobody. -->
  <p role="status" class="text-sm text-muted-foreground">
    {#if isBusy}
      Signing in…
    {/if}
  </p>
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
