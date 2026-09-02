<script lang="ts">
import { Button } from '$lib/components/ui/button';
import type { PageProps } from './$types';
import ReportsView from './reports-view.svelte';

let { data }: PageProps = $props();
</script>

<div class="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
  <h1 class="text-2xl font-semibold tracking-tight">{data.organization.name}</h1>
  <Button href={data.newReportHref}>New report</Button>
</div>

<ReportsView {data} />
