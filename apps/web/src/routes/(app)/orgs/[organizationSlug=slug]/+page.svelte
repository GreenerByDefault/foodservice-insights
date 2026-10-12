<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import type { PageProps } from './$types';
import ReportsView from './reports-list/reports-view.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Reports', data.organization.name)}</title>
</svelte:head>

<PageHeading>
  Reports
  {#snippet actions()}
    <Button href={data.newReportHref}>New report</Button>
  {/snippet}
</PageHeading>

<ReportsView {data} />
