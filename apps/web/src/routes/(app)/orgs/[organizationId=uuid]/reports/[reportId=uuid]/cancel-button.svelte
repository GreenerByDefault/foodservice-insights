<script lang="ts">
import { invalidateAll } from '$app/navigation';
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

let { cancelHref }: { cancelHref: string } = $props();

let open = $state(false);
let pending = $state(false);
let failed = $state(false);

async function confirm() {
  pending = true;
  failed = false;
  try {
    // Both outcomes close the dialog and refresh — see `CancelOutcome`.
    await cancelReport(cancelHref);
    open = false;
    // `depends()` isn't wired into this load yet (that lands with polling) — a targeted
    // `invalidate()` would match nothing without it, so `invalidateAll()` is the correct, if
    // broader, way to re-run this load for now.
    await invalidateAll();
  } catch {
    failed = true;
  } finally {
    pending = false;
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
        Stopping is final — this report cannot be retried. To run this data again, you will need to
        upload the file as a new report. The report itself stays in your list.
      </AlertDialogDescription>
    </AlertDialogHeader>
    {#if failed}
      <p class="text-sm text-destructive">Could not cancel this report. Please try again.</p>
    {/if}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={pending}>Keep it running</AlertDialogCancel>
      <AlertDialogAction variant="destructive" disabled={pending} onclick={confirm}>
        Yes, cancel report
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
