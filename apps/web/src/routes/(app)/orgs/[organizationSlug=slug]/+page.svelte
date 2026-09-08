<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import { Button } from '$lib/components/ui/button';
import type { PageProps } from './$types';
import ReportsView from './reports-list/reports-view.svelte';

let { data }: PageProps = $props();
</script>

<div class="flex w-full items-center justify-between">
  <PageHeading>Reports</PageHeading>
  <Button href={data.newReportHref}>New report</Button>
</div>

<ReportsView {data} />
