<script lang="ts">
import { REGEXP_ONLY_DIGITS } from 'bits-ui';
import { onDestroy, tick } from 'svelte';
import { toast } from 'svelte-sonner';
import type { BrowserAuth } from '#lib/auth/browser.js';
import { describeAuthError, FIELD, OTP_LENGTH, RESEND_COOLDOWN_S } from '#lib/auth/sign-in.js';
import { Button } from '#lib/components/ui/button/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import * as InputOTP from '#lib/components/ui/input-otp/index.js';

interface Props {
  auth: BrowserAuth;
  email: string;
  onSignedIn: () => Promise<void>;
  onChangeEmail: () => void;
}

let { auth, email, onSignedIn, onChangeEmail }: Props = $props();

type VerificationState =
  | { status: 'idle' }
  | { status: 'verifying' }
  | { status: 'failed'; message: string }
  /** Held until the navigation `onSignedIn` starts takes this step away: re-enabling the form
   * during it would invite a second `verifyOtp` with a code GoTrue has already spent. */
  | { status: 'verified' }
  /** Verified, but `onSignedIn` settled with the step still here, so it did not navigate — a
   * cookie the server could not read, say. The code is spent, so the way forward is another
   * `onSignedIn`, never another `verifyOtp`. */
  | { status: 'stalled' };

type ResendState =
  /** `message` is set when this cooldown was re-armed by a rate-limit failure, so the reason for
   * the wait stays on screen instead of disappearing the instant the button re-enables. */
  | { status: 'waiting'; remainingSeconds: number; message?: string }
  | { status: 'ready' }
  | { status: 'sending' }
  | { status: 'failed'; message: string };

let verificationState: VerificationState = $state({ status: 'idle' });
let resendState: ResendState = $state({ status: 'waiting', remainingSeconds: RESEND_COOLDOWN_S });
let code = $state('');
let codeInput: HTMLInputElement | null = $state(null);
let retryButton: HTMLButtonElement | null = $state(null);

const fieldId = $props.id();
const descriptionId = `${fieldId}-description`;
const errorId = `${fieldId}-error`;

// A request can outlive the step — a navigation away mid-send — and a write after that would call
// back into a parent that has moved on. So every `await` is followed by this check.
let isMounted = true;
onDestroy(() => {
  isMounted = false;
});

function isVerifying(state: VerificationState): boolean {
  return state.status === 'verifying' || state.status === 'verified';
}

function isStalled(state: VerificationState): boolean {
  return state.status === 'stalled';
}

function isResending(state: ResendState): boolean {
  return state.status === 'sending';
}

function resendStateMessage(state: ResendState): string | undefined {
  return state.status === 'failed' || state.status === 'waiting' ? state.message : undefined;
}

/** One lock across both requests. A resend that lands during a verify resets the step over the
 * outcome the verify is about to write, and one after a verify re-enables a field whose code is
 * spent. */
const isLocked = $derived(isVerifying(verificationState) || isResending(resendState));
/** Stalled leaves only the field locked: its code is spent, but a new code or a new address are
 * both a way out, and without them a sign-in the server keeps refusing has none. */
const isCodeLocked = $derived(isLocked || isStalled(verificationState));
const hasFullCode = $derived(code.length === OTP_LENGTH);
const resendErrorMessage = $derived(resendStateMessage(resendState));

// Read through a `$derived` rather than from `resendState` directly: the effect would otherwise
// depend on the whole of `resendState` and tear its own interval down and back up on every tick.
const isCountingDown = $derived(resendState.status === 'waiting');

$effect(() => {
  if (!isCountingDown) return;
  const interval = setInterval(() => {
    if (resendState.status !== 'waiting') return;
    resendState =
      resendState.remainingSeconds <= 1
        ? { status: 'ready' }
        : {
            status: 'waiting',
            remainingSeconds: resendState.remainingSeconds - 1,
            message: resendState.message,
          };
  }, 1000);
  return () => clearInterval(interval);
});

// Taking the code is the whole of this step, and the OS only offers a copied code to the field
// that already has focus — so arriving here without it would cost the visitor the autofill.
$effect(() => {
  codeInput?.focus();
});

/** Digits only. A code lifted out of an email arrives wrapped in whatever surrounded it — a
 * leading space, a trailing newline, the hyphens some senders break the digits with. `pattern`
 * only judges the result, so without this the whole paste is dropped and nothing appears. */
function keepDigits(text: string): string {
  return text.replaceAll(/\D/g, '');
}

async function submitCode() {
  if (isCodeLocked || !hasFullCode) return;

  verificationState = { status: 'verifying' };
  let errorMessage: string | null;
  try {
    const { error } = await auth.verifyOtp({ email, token: code, type: 'email' });
    errorMessage = error && describeAuthError(error);
  } catch (cause) {
    // The seam rejects, rather than answering `{ error }`, when the client itself could not load.
    console.error('Could not verify a sign-in code', cause);
    errorMessage = describeAuthError({});
  }
  if (!isMounted) return;

  if (errorMessage) {
    verificationState = { status: 'failed', message: errorMessage };
    // Cleared, not left in place, even when nothing judged the code: a full field has no room for
    // the next paste to land in, and bits-ui re-runs `onComplete` for a full value whenever its
    // effect re-runs — so a kept code would retry a failing call in a loop.
    code = '';
    // The field is `disabled` while verifying, and a disabled input cannot take focus.
    await tick();
    codeInput?.focus();
    return;
  }
  await finishSigningIn();
}

async function finishSigningIn() {
  verificationState = { status: 'verified' };
  try {
    await onSignedIn();
  } catch (cause) {
    console.error('Could not finish signing in', cause);
  }
  // A navigation unmounts this step before `onSignedIn` resolves — `invalidateAll()` awaits the
  // redirect it causes — so still being here means there was none.
  if (!isMounted) return;

  verificationState = { status: 'stalled' };
  await tick();
  retryButton?.focus();
}

/** The fallback behind `onComplete`. Nothing renders a submit button, but a form holding a single
 * field still submits on Enter — which is the only way forward if a value ever lands without
 * `onComplete` seeing the transition into it, as some password managers contrive to do. */
function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  void submitCode();
}

async function resendCode() {
  if (isLocked || resendState.status === 'waiting') return;

  resendState = { status: 'sending' };
  let errorMessage: string | null;
  let errorCode: string | null | undefined;
  try {
    // Passes `shouldCreateUser: false`, unlike the first send: reaching this step already proved
    // the account exists (see email-step.svelte), so needing to create one here would be a bug,
    // not a normal resend.
    const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    errorMessage = error && describeAuthError(error);
    errorCode = error?.code;
  } catch (cause) {
    console.error('Could not resend a sign-in code', cause);
    errorMessage = describeAuthError({});
  }
  if (!isMounted) return;

  if (errorMessage) {
    // A rate limit means the wait was too short, so it re-arms the same cooldown rather than
    // leaving the button clickable right under an error telling the visitor to wait.
    resendState =
      errorCode === 'over_email_send_rate_limit'
        ? { status: 'waiting', remainingSeconds: RESEND_COOLDOWN_S, message: errorMessage }
        : { status: 'failed', message: errorMessage };
    return;
  }
  code = '';
  verificationState = { status: 'idle' };
  resendState = { status: 'waiting', remainingSeconds: RESEND_COOLDOWN_S };
  // Disabled while the resend was in flight, like every other control.
  await tick();
  codeInput?.focus();
  toast.success(`Sent a new code to ${email}`);
}
</script>

<form onsubmit={handleSubmit} class="w-full space-y-4">
  <Field.Field>
    <Field.Label for={fieldId}>Sign-in code</Field.Label>
    <InputOTP.Root
      inputId={fieldId}
      name={FIELD.code}
      maxlength={OTP_LENGTH}
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={keepDigits}
      onComplete={() => void submitCode()}
      disabled={isCodeLocked}
      aria-invalid={verificationState.status === 'failed' || undefined}
      aria-describedby={verificationState.status === 'failed'
        ? `${descriptionId} ${errorId}`
        : descriptionId}
      bind:inputRef={codeInput}
      bind:value={code}
    >
      {#snippet children({
        cells,
      })}
        <InputOTP.Group>
          {#each cells as cell, index (index)}
            <InputOTP.Slot
              {cell}
              aria-invalid={verificationState.status === 'failed' || undefined}
            />
          {/each}
        </InputOTP.Group>
      {/snippet}
    </InputOTP.Root>
    <Field.Description id={descriptionId}>
      We sent a code to {email}. It expires shortly. We'll sign you in as soon as you enter it.
    </Field.Description>
    {#if verificationState.status === 'failed'}
      <Field.Error id={errorId}>{verificationState.message}</Field.Error>
    {/if}
  </Field.Field>

  <!-- Rendered whatever the state, rather than inside the `{#if}`: a live region is only
       announced if the screen reader was already watching the node when its text changed, so one
       that appears along with its message is read by nobody. -->
  <p role="status" class="text-sm text-muted-foreground">
    {#if verificationState.status === 'verifying' || verificationState.status === 'verified'}
      Signing in…
    {/if}
  </p>
</form>

{#if verificationState.status === 'stalled'}
  <div class="space-y-2">
    <p role="alert" class="text-sm text-destructive">
      Your code was verified, but we couldn't finish signing you in.
    </p>
    <Button bind:ref={retryButton} onclick={finishSigningIn} disabled={isResending(resendState)}>
      Try again
    </Button>
  </div>
{/if}

<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
  <Button
    variant="link"
    class="px-0"
    onclick={resendCode}
    disabled={isLocked || resendState.status === 'waiting'}
  >
    {#if resendState.status === 'waiting'}
      Send a new code in {resendState.remainingSeconds}s
    {:else if resendState.status === 'sending'}
      Sending…
    {:else}
      Send a new code
    {/if}
  </Button>
  <span aria-hidden="true" class="text-muted-foreground">•</span>
  <Button variant="link" class="px-0" onclick={onChangeEmail} disabled={isLocked}>
    Change email
  </Button>
</div>

{#if resendErrorMessage}
  <p role="alert" class="text-sm text-destructive">{resendErrorMessage}</p>
{/if}
