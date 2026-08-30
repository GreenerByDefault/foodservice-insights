<script lang="ts">
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
import { cancelReport } from '$lib/reports/cancel-report';
import type { ActionState } from '$lib/types/ActionState';

interface Props {
  cancelButtonHref: string;
  onReportChanged: () => Promise<void>;
}

let { cancelButtonHref, onReportChanged }: Props = $props();

let open = $state(false);
let actionState = $state<ActionState>({ status: 'idle' });

async function confirm() {
  actionState = { status: 'loading' };
  try {
    await cancelReport(cancelButtonHref);

    // Both outcomes close the dialog and refresh — see `CancelOutcome`.
    open = false;

    // The refresh cannot fail the cancel: the request already succeeded, and a refresh that
    // can't reach the server leaves the page on its last known state under its own reconnecting
    // notice. So `catch` below reports only what `cancelReport` threw.
    await onReportChanged();
    actionState = { status: 'success' };
  } catch {
    actionState = { status: 'error', message: 'Could not cancel this report. Please try again.' };
  }
}
</script>

<AlertDialog bind:open>
  <AlertDialogTrigger class={buttonVariants({ variant: 'outline' })}>
    Cancel report
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Cancel this report?</AlertDialogTitle>
      <AlertDialogDescription>
        This can't be undone. If you want to run this data again, upload it as a new report.
      </AlertDialogDescription>
    </AlertDialogHeader>
    {#if actionState.status === 'error'}
      <p class="text-sm text-destructive">{actionState.message}</p>
    {/if}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={actionState.status === 'loading'}>
        Keep it running
      </AlertDialogCancel>
      <AlertDialogAction
        variant="destructive"
        disabled={actionState.status === 'loading'}
        onclick={confirm}
      >
        Yes, cancel report
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
