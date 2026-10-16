<script lang="ts">
import type { CountsBasis, UnitSystem } from '@gbd/db';
import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
import { countsHeading, formatMonth } from '#lib/reports/monthly-counts.js';
import type { MonthlyCount } from './+page.server.ts';

interface Props {
  inputFile: { href: string; originalFilename: string };
  unitSystem: UnitSystem;
  countsBasis: CountsBasis;
  monthlyCounts: MonthlyCount[];
  newReportHref: string;
}

let { inputFile, unitSystem, countsBasis, monthlyCounts, newReportHref }: Props = $props();

// Leads with the upload form's own radio label, so it reads back as the thing the user clicked.
const UNIT_NAMES: Record<UnitSystem, string> = { lb: 'lb (pounds)', kg: 'kg (kilograms)' };
const countFormat = new Intl.NumberFormat('en-US');
const headingId = $props.id();

// Stacked on mobile; on `sm+`, every row shares the outer grid's label column through a subgrid.
const ROW_CLASS = 'flex flex-col gap-y-1 sm:col-span-2 sm:grid sm:grid-cols-subgrid';
</script>

<section aria-labelledby={headingId} class="mt-6 flex w-full flex-col gap-4 border-t pt-6">
  <h2 id={headingId} class="font-medium">Upload details</h2>

  <dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-[max-content_1fr]">
    <div class={ROW_CLASS}>
      <dt class="text-muted-foreground">File</dt>
      <dd class="min-w-0">
        <a
          class="inline-flex max-w-full items-center gap-1.5 underline hover:no-underline"
          href={inputFile.href}
        >
          <FileSpreadsheetIcon class="size-4 shrink-0" aria-hidden="true" />
          <span class="truncate">{inputFile.originalFilename}</span>
        </a>
      </dd>
    </div>

    <div class={ROW_CLASS}>
      <dt class="text-muted-foreground">Weight unit</dt>
      <dd>{UNIT_NAMES[unitSystem]}</dd>
    </div>

    <div class={ROW_CLASS}>
      <dt class="text-muted-foreground">{countsHeading(countsBasis)}</dt>
      <dd>
        <dl class="grid w-fit grid-cols-[auto_auto] gap-x-8 gap-y-1">
          {#each monthlyCounts as { month, count } (month)}
            <dt>{formatMonth(month)}</dt>
            <dd class="text-right tabular-nums">{countFormat.format(count)}</dd>
          {/each}
        </dl>
      </dd>
    </div>
  </dl>

  <p class="text-sm text-muted-foreground">
    Spot a mistake?
    <a class="underline hover:no-underline" href={newReportHref}>Upload your file again</a>
    with the right details.
  </p>
</section>
