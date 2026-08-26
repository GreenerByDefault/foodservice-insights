<script lang="ts">
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<!-- Deliberately undesigned: a switch over `data.attempt.status` rendering plain text and plain
     links, so every one of the four reachable outcomes (`canceled` is unreachable — see the
     `Attempt` doc comment in +page.server.ts) is legible before any of them is designed. The
     waiting view, the success view, the failure view and polling each replace one branch in a
     later PR. -->
<svelte:head>
  <title>{data.report.name}</title>
</svelte:head>

<h1 class="text-2xl font-semibold tracking-tight">{data.report.name}</h1>

{#if data.attempt.status === 'pending'}
  <p class="text-muted-foreground">
    Waiting to start. We checked your file
    <time datetime={data.attempt.createdAt.toISOString()}
      >{data.attempt.createdAt.toISOString()}</time
    >.
  </p>
{:else if data.attempt.status === 'processing'}
  <p class="text-muted-foreground">
    Analyzing. Started
    <time datetime={data.attempt.claimedAt.toISOString()}
      >{data.attempt.claimedAt.toISOString()}</time
    >.
  </p>
{:else if data.attempt.status === 'succeeded'}
  <p class="text-muted-foreground">
    Finished
    <time datetime={data.attempt.finishedAt.toISOString()}
      >{data.attempt.finishedAt.toISOString()}</time
    >.
  </p>
  <ul>
    {#if data.attempt.files.pdf}
      <li>
        <a class="underline hover:no-underline" href="/file/result/{data.attempt.files.pdf.id}">
          Download PDF
        </a>
      </li>
    {/if}
    {#if data.attempt.files.xlsx}
      <li>
        <a class="underline hover:no-underline" href="/file/result/{data.attempt.files.xlsx.id}">
          Download Excel
        </a>
      </li>
    {/if}
    {#each data.attempt.files.charts as chart (chart.id)}
      <li>
        <a class="underline hover:no-underline" href="/file/result/{chart.id}">{chart.chartKey}</a>
      </li>
    {/each}
  </ul>
  <p>
    <a class="underline hover:no-underline" href="/file/input/{data.inputFile.id}">
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
  <p class="text-muted-foreground">This report was canceled.</p>
{/if}
