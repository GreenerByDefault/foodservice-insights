<script lang="ts">
import type { Snippet } from 'svelte';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '$lib/components/ui/alert-dialog';
import { buttonVariants } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import type { ActionState } from '$lib/forms/action-state';

/** The confirm dialog behind every destructive action that needs an "are you sure" step: report
 * delete and cancel, and — with `confirmPhrase` set — organization delete. Handles the trigger,
 * the copy, and the loading/error state around one irreversible request.
 *
 * `open` is bindable so a caller that wants to close the dialog itself — cancel-button.svelte
 * does, right after its request succeeds and before it awaits a refresh that might be slow — can.
 * A caller with nothing to do once `onConfirm` resolves (delete-button.svelte navigates away
 * instead) can leave it unbound.
 */
interface Props {
  open?: boolean;
  trigger: Snippet;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  errorMessage: string;
  onConfirm: () => Promise<void>;
  /** When set, the destructive action stays disabled until the typed text exactly matches this —
   * on top of the existing `loading`-disables-it rule. Unset, the dialog renders no text input
   * and behaves exactly as it did before this prop existed. */
  confirmPhrase?: string;
}

let {
  open = $bindable(false),
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel,
  errorMessage,
  onConfirm,
  confirmPhrase,
}: Props = $props();

let actionState = $state<ActionState>({ status: 'idle' });
let typedPhrase = $state('');

const confirmDisabled = $derived(
  actionState.status === 'loading' ||
    (confirmPhrase !== undefined && typedPhrase !== confirmPhrase),
);

async function confirm() {
  actionState = { status: 'loading' };
  try {
    await onConfirm();
    actionState = { status: 'success' };
  } catch {
    actionState = { status: 'error', message: errorMessage };
  }
}
</script>

<AlertDialog bind:open>
  <AlertDialogTrigger class={buttonVariants({ variant: 'outline' })}>
    {@render trigger()}
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
    </AlertDialogHeader>
    {#if confirmPhrase !== undefined}
      <Field.Field>
        <Field.Label for="confirm-phrase">Type "{confirmPhrase}" to confirm</Field.Label>
        <Input id="confirm-phrase" autocomplete="off" bind:value={typedPhrase} />
      </Field.Field>
    {/if}
    {#if actionState.status === 'error'}
      <p class="text-sm text-destructive">{actionState.message}</p>
    {/if}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={actionState.status === 'loading'}>
        {cancelLabel}
      </AlertDialogCancel>
      <AlertDialogAction variant="destructive" disabled={confirmDisabled} onclick={confirm}>
        {confirmLabel}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
