<script lang="ts">
import type { ReportId } from '@gbd/db';
import { invalidate } from '$app/navigation';
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
import { reportDependencyKey } from '$lib/reports/report-dependency';
import type { ActionState } from '$lib/types/ActionState';

let { reportId, cancelButtonHref }: { reportId: ReportId; cancelButtonHref: string } = $props();

let open = $state(false);
let actionState = $state<ActionState>({ status: 'idle' });

async function confirm() {
  actionState = { status: 'loading' };
  try {
    await cancelReport(cancelButtonHref);

    // Both outcomes close the dialog and refresh — see `CancelOutcome`.
    open = false;

    await invalidate(reportDependencyKey(reportId));
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
