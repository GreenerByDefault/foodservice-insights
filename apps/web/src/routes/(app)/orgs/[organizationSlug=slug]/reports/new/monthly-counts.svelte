<script lang="ts">
import type { CountsBasis } from '@gbd/db';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';
import type { MonthsFromFile } from '#lib/reports/metadata.js';
import {
  type CountDraft,
  countsHeading,
  formatMonth,
  groupByYear,
  missingMonthCount,
} from '#lib/reports/monthly-counts.js';
import { cn } from '#lib/utils/shadcn.js';

interface Props {
  /** Undefined until a file is chosen. The guidance on what to count still shows, so the user can
   * gather the right numbers before they upload. */
  months: MonthsFromFile | undefined;
  basis: CountsBasis;
  counts: CountDraft;
}

let { months, basis, counts = $bindable() }: Props = $props();

const legend = $derived(countsHeading(basis));
const counted = $derived(basis === 'people' ? 'diners' : 'meals');
const monthsOrNone = $derived(months ?? []);
const groups = $derived(groupByYear(monthsOrNone));
const showYearHeadings = $derived(groups.length > 1);
// A tally of one month says nothing the single input doesn't.
const showProgress = $derived(monthsOrNone.length > 1);
// "filled in" rather than "still needs a count", whose verb would have to agree with the number.
const progress = $derived(
  `${monthsOrNone.length - missingMonthCount(counts, monthsOrNone)} of ${monthsOrNone.length} months filled in`,
);
// `MAX_MONTHS` is 120, so a single column still has to be usable for a decade of history. A short
// column stays narrow, so each label sits near its input rather than across the page from it.
const gridClass = $derived(monthsOrNone.length <= 6 ? 'max-w-xs' : 'sm:grid-cols-2 sm:gap-x-12');
const id = $props.id();
const scopeId = `${id}-scope`;
const progressId = `${id}-progress`;
</script>

<!-- `mt-3` sets it apart from the radios above it, which sit closer together. -->
<Field.Set
  class="mt-3 gap-4"
  aria-describedby={showProgress ? `${scopeId} ${progressId}` : scopeId}
>
  <Field.Legend variant="label">{legend}</Field.Legend>
  <!-- A whole campus's count against one dining hall's purchases makes every per-diner figure
       wrong. -->
  <Field.Description id={scopeId}>
    Use counts for the same sites as your file. For example, if your file only covers one dining
    hall, count only that dining hall's {counted}, not the whole university's.
  </Field.Description>
  {#if showProgress}
    <!-- Live for now, though chatty: it speaks after each field once typing pauses. It is the only
         sense of progress through up to 120 fields. Revisit if it proves too noisy. -->
    <Field.Description id={progressId} aria-live="polite">{progress}</Field.Description>
  {/if}

  {#if !months}
    <!-- Dashed, like the drop zone, to mark a space that fills in once a file is chosen. -->
    <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      Choose a file above, and each month it covers will appear here.
    </p>
  {/if}

  {#each groups as group (group.year)}
    <div class="space-y-2">
      {#if showYearHeadings}
        <h2 class="font-sans text-sm font-medium text-muted-foreground">{group.year}</h2>
      {/if}
      <div class={cn('grid grid-cols-1 gap-y-2', gridClass)}>
        {#each group.months as month (month)}
          <Field.Field orientation="horizontal">
            <Field.Label for="monthly-count-{month}">{formatMonth(month)}</Field.Label>
            <Input
              id="monthly-count-{month}"
              class="w-32 shrink-0"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              autocomplete="off"
              required
              bind:value={counts[month]}
            />
          </Field.Field>
        {/each}
      </div>
    </div>
  {/each}
</Field.Set>
