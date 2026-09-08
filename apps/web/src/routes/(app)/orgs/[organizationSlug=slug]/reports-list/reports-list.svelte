<script lang="ts">
import ItemList from '$lib/components/item-list.svelte';
import type { ReportsPageData } from '../+page.server.ts';
import ReportRow from './report-row.svelte';

interface Props {
  reports: ReportsPageData['reports'];
}

let { reports }: Props = $props();
</script>

<ItemList items={reports} key={(report) => report.id} empty="No reports yet.">
  {#snippet children(report)}
    <ReportRow {report} />
  {/snippet}
</ItemList>
