<script lang="ts">
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import { goto } from '$app/navigation';
import ConfirmAction from '$lib/components/confirm-action.svelte';
import { organizationHref } from '$lib/hrefs';
import { deleteReport } from '$lib/reports/api/delete-report';

let { organizationId, reportId }: { organizationId: string; reportId: string } = $props();

async function confirm() {
  await deleteReport(organizationId, reportId);
  // This page 404s the moment the report is gone, so land on the organization instead.
  await goto(organizationHref(organizationId));
}
</script>

{#snippet trigger()}
  <Trash2Icon aria-hidden="true" />
  Delete report
{/snippet}

<ConfirmAction
  {trigger}
  title="Delete this report?"
  description="This removes the report and its files permanently. This can't be undone."
  confirmLabel="Yes, delete report"
  cancelLabel="Keep it"
  errorMessage="Could not delete this report. Please try again."
  onConfirm={confirm}
/>
