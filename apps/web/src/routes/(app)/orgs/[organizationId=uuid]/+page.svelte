<script lang="ts">
import { Button } from '$lib/components/ui/button';
import type { PageProps } from './$types';
import ReportsList from './reports-list.svelte';

let { data }: PageProps = $props();
</script>

<!-- The dashboard is the list — REQUIREMENTS.md asks for no search and no filtering.
flex-col below sm: a long org name wrapping to two lines left "New report" centered against
both, off from the first line it reads with. Stacked, the button sits right under a wrapped
heading instead. -->
<div class="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
  <h1 class="text-2xl font-semibold tracking-tight">{data.organization.name}</h1>
  <Button href={data.newReportHref}>New report</Button>
</div>

<ReportsList reports={data.reports} />
