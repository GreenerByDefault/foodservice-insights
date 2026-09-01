<script lang="ts">
import { cancelReport } from '$lib/reports/cancel-report';
import ConfirmAction from '../confirm-action.svelte';

interface Props {
  cancelButtonHref: string;
  onReportChanged: () => Promise<void>;
}

let { cancelButtonHref, onReportChanged }: Props = $props();

let open = $state(false);

async function confirm() {
  await cancelReport(cancelButtonHref);

  // Both outcomes close the dialog and refresh — see `CancelOutcome`.
  open = false;

  // The refresh cannot fail the cancel: the request already succeeded, and a refresh that
  // can't reach the server leaves the page on its last known state under its own reconnecting
  // notice. So a failure past this point isn't reported as a cancel error.
  await onReportChanged();
}
</script>

{#snippet trigger()}
  Cancel report
{/snippet}

<ConfirmAction
  bind:open
  {trigger}
  title="Cancel this report?"
  description="This can't be undone. If you want to run this data again, upload it as a new report."
  confirmLabel="Yes, cancel report"
  cancelLabel="Keep it running"
  errorMessage="Could not cancel this report. Please try again."
  onConfirm={confirm}
/>
