<script lang="ts">
import ReportView from './report-view.svelte';
import type { PageProps } from './$types';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle(data.report.name, data.organization.name)}</title>
</svelte:head>

<ReportView {data} />
