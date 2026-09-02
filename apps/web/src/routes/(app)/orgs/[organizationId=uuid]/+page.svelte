<script lang="ts">
import { Button } from '$lib/components/ui/button';
import type { PageProps } from './$types';
import ReportsList from './reports-list.svelte';

let { data }: PageProps = $props();
</script>

<!-- The dashboard is the list — REQUIREMENTS.md asks for no search and no filtering. -->
<div class="flex w-full items-center justify-between">
  <h1 class="text-2xl font-semibold tracking-tight">{data.organization.name}</h1>
  <Button href={data.newReportHref}>New report</Button>
</div>

<ReportsList reports={data.reports} />
