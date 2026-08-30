<script lang="ts">
import type { ReportId } from '@gbd/db';
import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
import { invalidate } from '$app/navigation';
import { Button } from '$lib/components/ui/button';
import { retryReport } from '$lib/reports/retry-report';
import { reportDependencyKey } from '$lib/reports/report-dependency';
import type { ActionState } from '$lib/types/ActionState';
import type { FailureCopy } from './+page.server.ts';

let {
  reportId,
  attemptNumber,
  failure,
  retryButtonHref,
}: {
  reportId: ReportId;
  attemptNumber: number;
  failure: FailureCopy;
  retryButtonHref: string;
} = $props();

let actionState = $state<ActionState>({ status: 'idle' });

async function retry() {
  actionState = { status: 'loading' };
  try {
    await retryReport(retryButtonHref);

    // Both outcomes mean a new attempt exists (or one already did). The invalidate reloads
    // the page to show the new attempt.
    await invalidate(reportDependencyKey(reportId));
    actionState = { status: 'success' };
  } catch {
    actionState = { status: 'error', message: 'Could not retry this report. Please try again.' };
  }
}
</script>

<div class="space-y-4">
  <div class="flex gap-3">
    <CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="space-y-1">
      <p class="font-medium">{failure.whatHappened}</p>
      <p class="text-muted-foreground text-sm">{failure.followUpText}</p>
      {#if attemptNumber > 1 && !failure.attemptsExhausted}
        <p class="text-muted-foreground text-sm">This was attempt {attemptNumber}.</p>
      {/if}
    </div>
  </div>

  {#if actionState.status === 'error'}
    <p class="text-sm text-destructive">{actionState.message}</p>
  {/if}

  <div class="flex items-center gap-4">
    {#if failure.canRetry}
      <Button disabled={actionState.status === 'loading'} onclick={retry}>Retry</Button>
    {/if}
    <a class="text-sm underline hover:no-underline" href={failure.contactMailto}>Contact us</a>
  </div>
</div>
