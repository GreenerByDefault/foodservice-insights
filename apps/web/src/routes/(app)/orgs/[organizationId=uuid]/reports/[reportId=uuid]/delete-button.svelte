<script lang="ts">
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import { goto } from '$app/navigation';
import { deleteReport } from '$lib/reports/api/delete-report';
import ConfirmAction from './confirm-action.svelte';
import type { DeleteAction } from './+page.server.ts';

let { action }: { action: DeleteAction } = $props();

async function confirm() {
  await deleteReport(action.href);
  await goto(action.afterHref);
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
