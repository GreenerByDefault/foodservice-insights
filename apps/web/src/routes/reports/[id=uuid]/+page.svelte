<script lang="ts">
import type { PageProps } from './$types';

let { data }: PageProps = $props();
const report = $derived(data.report);
</script>

<h1 class="font-semibold text-2xl">{report.name ?? 'Untitled report'}</h1>

<p class="text-muted-foreground">
  Placeholder. The real result page — charts, the timeline, downloads — arrives with the frontend.
</p>

<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
  <dt class="text-muted-foreground">Organization</dt>
  <dd>{data.session?.organization.name ?? 'unknown'}</dd>

  <dt class="text-muted-foreground">Site</dt>
  <dd>{report.siteName ?? '—'}</dd>

  <dt class="text-muted-foreground">Measured in</dt>
  <dd>{report.unitSystem}, by {report.countsBasis}</dd>

  <dt class="text-muted-foreground">Months</dt>
  <dd>{Object.keys(report.monthlyCounts).length}</dd>

  <dt class="text-muted-foreground">Input file</dt>
  <dd>
    <a class="underline" href="/file/input/{report.inputFile.id}"
      >{report.inputFile.originalFilename}</a
    >
  </dd>

  <dt class="text-muted-foreground">Status</dt>
  <dd>{report.attempt?.status ?? 'no attempt yet'}</dd>
</dl>
