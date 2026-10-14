<script lang="ts">
import { onDestroy } from 'svelte';
import { signInWithSitePassword } from '#lib/auth/site-session.js';
import { Button } from '#lib/components/ui/button/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';

interface Props {
  /** What to do once the session cookie exists. A `refreshAll()`, so the server sees the
   * session and its own redirect takes over. */
  onSignedIn: () => Promise<void>;
}

let { onSignedIn }: Props = $props();

type FormState =
  | { status: 'idle' }
  | { status: 'signing-in' }
  | { status: 'failed'; message: string };

const COULD_NOT_SIGN_IN = "Couldn't sign in. Try again.";

let formState: FormState = $state({ status: 'idle' });
let password = $state('');
let passwordInputElement: HTMLInputElement | null = $state(null);

const fieldId = $props.id();
const errorId = `${fieldId}-error`;

// A request can outlive the form — a navigation away mid-request — and a write after that would
// call back into a parent that has moved on. So every `await` is followed by this check.
let isMounted = true;
onDestroy(() => {
  isMounted = false;
});

function fail(message: string) {
  formState = { status: 'failed', message };
  passwordInputElement?.focus();
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'signing-in') return;

  formState = { status: 'signing-in' };
  const outcome = await signInWithSitePassword(password);
  if (!isMounted) return;

  if (outcome.kind !== 'signed-in') {
    fail(outcome.kind === 'wrong-password' ? "That password isn't right." : COULD_NOT_SIGN_IN);
    return;
  }

  // Still `signing-in` while this runs, so the button does not re-enable under a visitor who is
  // already signed in.
  try {
    await onSignedIn();
  } catch (cause) {
    console.error('Could not finish signing in', cause);
  }
  // A navigation unmounts this form before `onSignedIn` resolves — `refreshAll()` awaits the
  // redirect it causes — so still being here means the server did not see the session.
  if (!isMounted) return;
  fail(COULD_NOT_SIGN_IN);
}
</script>

<form onsubmit={handleSubmit} class="w-full space-y-8">
  <Field.Field>
    <Field.Label for={fieldId}>Password</Field.Label>
    <Input
      bind:ref={passwordInputElement}
      id={fieldId}
      name="password"
      type="password"
      autocomplete="current-password"
      required
      aria-invalid={formState.status === 'failed' || undefined}
      aria-describedby={formState.status === 'failed' ? errorId : undefined}
      bind:value={password}
    />
    {#if formState.status === 'failed'}
      <Field.Error id={errorId}>{formState.message}</Field.Error>
    {/if}
  </Field.Field>

  <Button
    type="submit"
    class="w-full"
    disabled={formState.status === 'signing-in'}
    aria-busy={formState.status === 'signing-in'}
  >
    {formState.status === 'signing-in' ? 'Signing in…' : 'Sign in'}
  </Button>
</form>
