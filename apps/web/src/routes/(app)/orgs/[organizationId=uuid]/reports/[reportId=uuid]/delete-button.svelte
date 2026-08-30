<script lang="ts">
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import { goto } from '$app/navigation';
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
import { deleteReport } from '$lib/reports/delete-report';
import type { ActionState } from '$lib/types/ActionState';
import type { DeleteAction } from './+page.server.ts';

let { action }: { action: DeleteAction } = $props();

let open = $state(false);
let actionState = $state<ActionState>({ status: 'idle' });

async function confirm() {
  actionState = { status: 'loading' };
  try {
    await deleteReport(action.href);
    await goto(action.afterHref);
  } catch {
    actionState = { status: 'error', message: 'Could not delete this report. Please try again.' };
  }
}
</script>

<AlertDialog bind:open>
  <AlertDialogTrigger class={buttonVariants({ variant: 'outline' })}>
    <Trash2Icon aria-hidden="true" />
    Delete report
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete this report?</AlertDialogTitle>
      <AlertDialogDescription>
        This removes the report and its files permanently. This can't be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    {#if actionState.status === 'error'}
      <p class="text-sm text-destructive">{actionState.message}</p>
    {/if}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={actionState.status === 'loading'}>Keep it</AlertDialogCancel>
      <AlertDialogAction
        variant="destructive"
        disabled={actionState.status === 'loading'}
        onclick={confirm}
      >
        Yes, delete report
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
