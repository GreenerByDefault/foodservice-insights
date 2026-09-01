<script lang="ts">
import type { ReportsPageData } from './+page.server.ts';
import ReportRow from './report-row.svelte';

interface Props {
  reports: ReportsPageData['reports'];
  newReportHref: string;
}

let { reports, newReportHref }: Props = $props();
</script>

{#if reports.length === 0}
  <!-- Invented for this screen — there is no precedent elsewhere in the app. It also doubles as
  the first-run experience, so it stays to one muted sentence plus the same call to action a
  populated list has above it. -->
  <p class="w-full text-muted-foreground">
    No reports yet.
    <a class="underline hover:no-underline" href={newReportHref}>Upload your first one</a>.
  </p>
{:else}
  <ul class="w-full divide-y">
    {#each reports as report (report.id)}
      <ReportRow {report} />
    {/each}
  </ul>
{/if}
