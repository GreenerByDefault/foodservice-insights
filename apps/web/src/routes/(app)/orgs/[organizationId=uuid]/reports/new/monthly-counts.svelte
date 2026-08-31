<script lang="ts">
import type { CountsBasis } from '@gbd/db';
import * as Field from '$lib/components/ui/field/index.js';
import { Input } from '$lib/components/ui/input/index.js';
import type { MonthsFromFile } from '$lib/reports/metadata';
import {
  type CountDraft,
  formatMonth,
  groupByYear,
  missingMonthCount,
} from '$lib/reports/monthly-counts';

let {
  months,
  basis,
  counts = $bindable(),
}: {
  months: MonthsFromFile;
  basis: CountsBasis;
  counts: CountDraft;
} = $props();

const legend = $derived(basis === 'people' ? 'Diners per month' : 'Meals per month');
const groups = $derived(groupByYear(months));
const showYearHeadings = $derived(groups.length > 1);
const missing = $derived(missingMonthCount(counts, months));
// `MAX_MONTHS` is 120, so a single column still has to be usable for a decade of history.
const gridClass = $derived(months.length <= 6 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2');
const progressId = 'monthly-counts-progress';
</script>

<Field.Set aria-describedby={progressId}>
  <Field.Legend>{legend}</Field.Legend>
  <Field.Description id={progressId} aria-live="polite">
    {missing}
    of {months.length} months still need a count
  </Field.Description>

  {#each groups as group (group.year)}
    {#if showYearHeadings}
      <h3 class="text-sm font-medium text-muted-foreground">{group.year}</h3>
    {/if}
    <div class="grid {gridClass} gap-3">
      {#each group.months as month (month)}
        <Field.Field>
          <Field.Label for="monthly-count-{month}">{formatMonth(month)}</Field.Label>
          <Input
            id="monthly-count-{month}"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            autocomplete="off"
            required
            bind:value={counts[month]}
          />
        </Field.Field>
      {/each}
    </div>
  {/each}
</Field.Set>
