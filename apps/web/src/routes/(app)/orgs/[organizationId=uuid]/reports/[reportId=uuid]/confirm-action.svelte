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
import type { ActionState } from '$lib/types/action-state';

/** The confirm dialog behind both destructive report actions (delete, cancel): the trigger, the
 * "are you sure" copy, and the loading/error handling around one irreversible request.
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
}: Props = $props();

let actionState = $state<ActionState>({ status: 'idle' });

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
    {#if actionState.status === 'error'}
      <p class="text-sm text-destructive">{actionState.message}</p>
    {/if}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={actionState.status === 'loading'}>
        {cancelLabel}
      </AlertDialogCancel>
      <AlertDialogAction
        variant="destructive"
        disabled={actionState.status === 'loading'}
        onclick={confirm}
      >
        {confirmLabel}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
