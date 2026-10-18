<script lang="ts">
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
import { AlertDescription, AlertTitle, alertVariants } from '#lib/components/ui/alert/index.js';
import { cn } from '#lib/utils/shadcn.js';
import type { Finding } from './+page.server.ts';

let { findings }: { findings: Finding[] } = $props();

const headingId = $props.id();

let heading = $derived(
  `This report has ${findings.length} data quality ${findings.length === 1 ? 'warning' : 'warnings'}`,
);
</script>

{#if findings.length > 0}
  <!-- Styled as an `Alert` without being one: `role="alert"` would interrupt a screen reader when a
       poll swaps in the result, and the live headline in `report-view.svelte` already announces
       that. -->
  <section
    aria-labelledby={headingId}
    class={cn(
      alertVariants(),
      'border-amber-300 bg-amber-50 px-4 py-4 *:[svg]:text-amber-700 sm:px-5',
    )}
  >
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>
      <h2 id={headingId} class="text-base font-medium text-foreground">{heading}</h2>
    </AlertTitle>
    <AlertDescription class="text-pretty">
      <p>Read them before you share the results.</p>
    </AlertDescription>

    <ul class="col-span-full mt-4 space-y-4 sm:col-start-2">
      {#each findings as finding, index (index)}
        <li class="space-y-1.5 border-t border-amber-200 pt-4 first:border-t-0 first:pt-0">
          <p class="text-pretty text-foreground">{finding.message}</p>
          {#if finding.sampleValues.length > 0}
            <details class="group">
              <!-- The padding grows the tap target to 36px tall, past WCAG's 24px minimum, and the
                   negative margin gives it back so the layout does not move. Any taller and it
                   would cover the first example once they are open. -->
              <summary
                class="-mx-1 -my-2 inline-flex cursor-pointer list-none items-center gap-1 rounded-sm px-1 py-2 font-medium text-amber-800 hover:text-amber-950 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
              >
                <ChevronRightIcon
                  class="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                  aria-hidden="true"
                />
                Examples ({finding.sampleValues.length})
              </summary>
              <ul
                class="mt-2 ml-2 space-y-1 border-l-2 border-amber-200 pl-3 text-muted-foreground"
              >
                {#each finding.sampleValues as sample, sampleIndex (sampleIndex)}
                  <li class="text-pretty break-words">{sample}</li>
                {/each}
              </ul>
            </details>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
