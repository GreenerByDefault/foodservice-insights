<script lang="ts">
import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
import MailIcon from '@lucide/svelte/icons/mail';
import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
import { Button } from '$lib/components/ui/button';
import { retryReport } from '$lib/reports/api/retry-report';
import type { ActionState } from '$lib/forms/action-state';
import type { DeleteAction } from '../+page.server.ts';
import DeleteButton from '../delete-button.svelte';
import type { FailureCopy } from './failure-copy.ts';
import StatusLine from '../status-line.svelte';

interface Props {
  attemptNumber: number;
  failure: FailureCopy;
  retryButtonHref: string;
  deleteAction: DeleteAction;
  onReportChanged: () => Promise<void>;
}

let { attemptNumber, failure, retryButtonHref, deleteAction, onReportChanged }: Props = $props();

let actionState = $state<ActionState>({ status: 'idle' });

async function retry() {
  actionState = { status: 'loading' };
  try {
    await retryReport(retryButtonHref);

    // Both outcomes mean a new attempt exists (or one already did), so refresh either way. The
    // refresh cannot fail the retry — see the same note in `waiting/cancel-button.svelte`.
    await onReportChanged();
    actionState = { status: 'success' };
  } catch {
    actionState = { status: 'error', message: 'Could not retry this report. Please try again.' };
  }
}
</script>

<div class="space-y-4">
  <StatusLine icon={CircleAlertIcon}>
    <div class="space-y-1">
      <p class="font-medium">{failure.whatHappened}</p>
      <p class="text-muted-foreground text-sm">{failure.followUpText}</p>
      {#if attemptNumber > 1 && !failure.attemptsExhausted}
        <p class="text-muted-foreground text-sm">This was attempt {attemptNumber}.</p>
      {/if}
    </div>
  </StatusLine>

  {#if actionState.status === 'error'}
    <p class="text-sm text-destructive">{actionState.message}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-3">
    {#if failure.canRetry}
      <Button disabled={actionState.status === 'loading'} onclick={retry}>
        <RefreshCwIcon aria-hidden="true" />
        Retry
      </Button>
    {/if}
    <Button href={failure.contactMailto} variant="outline">
      <MailIcon aria-hidden="true" />
      Contact us
    </Button>
    <DeleteButton action={deleteAction} />
  </div>
</div>
