<script lang="ts">
import CanceledView from './canceled-view.svelte';
import type { PageProps } from './$types';
import { isWaiting } from './waiting/progress.ts';
import WaitingView from './waiting/view.svelte';

let { data }: PageProps = $props();
</script>

<!-- Deliberately undesigned past the waiting and canceled views: a switch over
     `data.attempt.status` rendering plain text and plain links for the two outcomes still
     unbuilt, so they are legible before each is designed in a later PR. `data.attempt.status` is
     the screen rather than the column — the load settles the cancel-versus-verdict ordering, so a
     cancel no worker has converged yet already arrives here as `canceled`. -->
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
  <p>{data.attempt.failure.whatHappened}</p>
  <p class="text-muted-foreground">{data.attempt.failure.followUpText}</p>
  {#if data.attempt.attemptNumber > 1}
    <p class="text-muted-foreground">This was attempt {data.attempt.attemptNumber}.</p>
  {/if}
  <p>
    <a class="underline hover:no-underline" href={data.attempt.failure.contactMailto}>
      Contact us
    </a>
  </p>
{:else if data.attempt.status === 'canceled'}
  <CanceledView
    stoppedAt={data.attempt.stoppedAt}
    now={data.now}
    newReportHref={data.newReportHref}
  />
{/if}
