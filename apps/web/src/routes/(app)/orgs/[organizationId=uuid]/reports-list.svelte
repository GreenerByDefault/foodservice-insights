<script lang="ts">
import type { ReportsPageData } from './+page.server.ts';
import ReportRow from './report-row.svelte';

interface Props {
  reports: ReportsPageData['reports'];
}

let { reports }: Props = $props();
</script>

{#if reports.length === 0}
  <!-- Invented for this screen — there is no precedent elsewhere in the app. The "New report"
  button above is the only call to action; repeating it here would just be noise. -->
  <p class="w-full text-muted-foreground">No reports yet.</p>
{:else}
  <!-- border-y, not just divide-y: with a single report there's no divider to draw at all, and a
  lone bare row reads as stray text rather than a clickable list. -->
  <ul class="w-full divide-y border-y">
    {#each reports as report (report.id)}
      <ReportRow {report} />
    {/each}
  </ul>
{/if}
