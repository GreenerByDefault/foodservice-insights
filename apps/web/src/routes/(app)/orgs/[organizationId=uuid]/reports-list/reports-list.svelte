<script lang="ts">
import type { ReportsPageData } from '../+page.server.ts';
import ReportRow from './report-row.svelte';

interface Props {
  reports: ReportsPageData['reports'];
}

let { reports }: Props = $props();
</script>

{#if reports.length === 0}
  <p class="w-full text-muted-foreground">No reports yet.</p>
{:else}
  <ul class="w-full divide-y border-y">
    {#each reports as report (report.id)}
      <ReportRow {report} />
    {/each}
  </ul>
{/if}
