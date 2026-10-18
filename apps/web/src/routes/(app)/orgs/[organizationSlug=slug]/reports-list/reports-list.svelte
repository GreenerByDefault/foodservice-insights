<script lang="ts">
import FileChartColumnIcon from '@lucide/svelte/icons/file-chart-column';
import ItemList from '#lib/components/item-list.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import * as Card from '#lib/components/ui/card/index.js';
import type { ReportsPageData } from '../+page.server.ts';
import ReportRow from './report-row.svelte';

interface Props {
  reports: ReportsPageData['reports'];
  newReportHref: string;
}

let { reports, newReportHref }: Props = $props();
</script>

{#snippet empty()}
  <Card.Root class="w-full">
    <Card.Content class="items-center gap-4 py-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-full bg-muted">
        <FileChartColumnIcon class="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <div class="flex flex-col gap-1">
        <p class="text-base font-medium">No reports yet.</p>
        <p class="text-muted-foreground">
          Upload a file of your food purchases to see its climate impact.
        </p>
      </div>
      <Button href={newReportHref}>New report</Button>
    </Card.Content>
  </Card.Root>
{/snippet}

<ItemList items={reports} key={(report) => report.id} {empty}>
  {#snippet children(
    report,
  )}
    <ReportRow {report} />
  {/snippet}
</ItemList>
