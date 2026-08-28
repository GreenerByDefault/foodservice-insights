<script lang="ts">
import CanceledView from './canceled-view.svelte';
import FailureView from './failure-view.svelte';
import type { PageProps } from './$types';
import { isWaiting } from './waiting/progress.ts';
import WaitingView from './waiting/view.svelte';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.report.name}</title>
</svelte:head>

<h1 class="text-2xl font-semibold tracking-tight">{data.report.name}</h1>

{#if isWaiting(data.attempt)}
  <WaitingView
    reportId={data.report.id}
    attempt={data.attempt}
    now={data.now}
    cancelButtonHref={data.cancelButtonHref}
  />
{:else if data.attempt.status === 'succeeded'}
  <p class="text-muted-foreground">
    Finished
    <time datetime={data.attempt.finishedAt.toISOString()}
      >{data.attempt.finishedAt.toISOString()}</time
    >.
  </p>
  <ul>
    <li>
      <a class="underline hover:no-underline" href={data.attempt.files.pdf.href}> Download PDF </a>
    </li>
    <li>
      <a class="underline hover:no-underline" href={data.attempt.files.xlsx.href}>
        Download Excel
      </a>
    </li>
    {#each data.attempt.files.charts as chart (chart.href)}
      <li>
        <a class="underline hover:no-underline" href={chart.href}>{chart.chartKey}</a>
      </li>
    {/each}
  </ul>
  <p>
    <a class="underline hover:no-underline" href={data.inputFile.href}>
      {data.inputFile.originalFilename}
    </a>
  </p>
{:else if data.attempt.status === 'failed'}
  <FailureView
    reportId={data.report.id}
    attemptNumber={data.attempt.attemptNumber}
    failure={data.attempt.failure}
    retryButtonHref={data.retryButtonHref}
  />
{:else if data.attempt.status === 'canceled'}
  <CanceledView
    stoppedAt={data.attempt.stoppedAt}
    now={data.now}
    newReportHref={data.newReportHref}
  />
{/if}
