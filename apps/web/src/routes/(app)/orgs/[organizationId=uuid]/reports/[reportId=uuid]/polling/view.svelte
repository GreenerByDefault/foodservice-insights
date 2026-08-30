<script lang="ts">
import { invalidate } from '$app/navigation';
import { reportDependencyKey } from '$lib/reports/report-dependency';
import type { ReportPageData } from '../+page.server.ts';
import CanceledView from '../canceled-view.svelte';
import FailureView from '../failure-view.svelte';
import ResultView from '../result/view.svelte';
import { describeProgress, isWaiting } from '../waiting/progress.ts';
import WaitingView from '../waiting/view.svelte';

let { data }: { data: ReportPageData } = $props();

async function onReportChanged(): Promise<void> {
  await invalidate(reportDependencyKey(data.report.id));
}

let headline = $derived(screenHeadline(data));

/** What the live region announces. */
function screenHeadline(report: ReportPageData): string {
  switch (report.attempt.status) {
    case 'pending':
    case 'processing':
      return describeProgress(report.attempt, report.now).headline;
    case 'succeeded':
      return 'Your report is ready';
    case 'failed':
      return 'Your report could not be finished';
    case 'canceled':
      return 'This report was stopped';
  }
}
</script>

<svelte:head>
  <title>{data.report.name}</title>
</svelte:head>

<h1 class="text-2xl font-semibold tracking-tight">{data.report.name}</h1>

<!-- Outside the switch on purpose so that it is not unmounted when the view changes. -->
<div aria-live="polite" class="sr-only">{headline}</div>

{#if isWaiting(data.attempt)}
  <WaitingView
    attempt={data.attempt}
    now={data.now}
    cancelButtonHref={data.cancelButtonHref}
    {onReportChanged}
  />
{:else if data.attempt.status === 'succeeded'}
  <ResultView
    finishedAt={data.attempt.finishedAt}
    files={data.attempt.files}
    inputFile={data.inputFile}
  />
{:else if data.attempt.status === 'failed'}
  <FailureView
    attemptNumber={data.attempt.attemptNumber}
    failure={data.attempt.failure}
    retryButtonHref={data.retryButtonHref}
    {onReportChanged}
  />
{:else if data.attempt.status === 'canceled'}
  <CanceledView
    stoppedAt={data.attempt.stoppedAt}
    now={data.now}
    newReportHref={data.newReportHref}
  />
{/if}
