<script lang="ts">
import { invalidate } from '$app/navigation';
import { reportDependencyKey } from '$lib/reports/report-dependency';
import CanceledView from './canceled-view.svelte';
import FailureView from './failure-view.svelte';
import ResultView from './result/view.svelte';
import type { PageProps } from './$types';
import { isWaiting } from './waiting/progress.ts';
import WaitingView from './waiting/view.svelte';

let { data }: PageProps = $props();

async function onReportChanged(): Promise<void> {
  await invalidate(reportDependencyKey(data.report.id));
}
</script>

<svelte:head>
  <title>{data.report.name}</title>
</svelte:head>

<h1 class="text-2xl font-semibold tracking-tight">{data.report.name}</h1>

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
