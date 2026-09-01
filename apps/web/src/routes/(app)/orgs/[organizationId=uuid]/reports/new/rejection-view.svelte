<script lang="ts">
import { Button } from '$lib/components/ui/button';
import { formatRowSpan } from '$lib/reports/csv/describe';
import type { UploadRejection } from '$lib/reports/rejection';
import { cn } from '$lib/utils/shadcn';

interface Props {
  rejection: UploadRejection;
  onBack: () => void;
}

let { rejection, onBack }: Props = $props();

let headingElement: HTMLHeadingElement | undefined = $state();

// A rejection is a finished verdict, not a live update — README.md § Errors rules out a live
// region for a document this long, so the fix is moving focus, once, to the heading that names it.
$effect(() => {
  headingElement?.focus();
});

// Whether there's a row list or date-order block below the heading long enough that a
// reader scrolling back up benefits from a button up there too, instead of hunting for the
// one at the bottom.
let hasScrollableDetail = $derived(
  Boolean(rejection.rowProblems?.length || rejection.dateOrderProblem),
);
</script>

{#snippet backButton(variant?: 'outline')}
  <Button {variant} onclick={onBack}>Back to the form</Button>
{/snippet}

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <h2 bind:this={headingElement} tabindex="-1" class="text-lg font-semibold outline-none">
      {rejection.summary}
    </h2>
    {#if hasScrollableDetail}
      {@render backButton('outline')}
    {/if}
  </div>

  {#if rejection.dateOrderProblem}
    <div class="rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <p class="text-xs font-medium uppercase tracking-wide text-destructive">
        Affects the whole file
      </p>
      <p class="mt-1 text-sm">{rejection.dateOrderProblem}</p>
    </div>
  {/if}

  {#if rejection.rowProblems}
    <ol class="space-y-4">
      {#each rejection.rowProblems as problem, index (index)}
        <li
          class={cn(
            'grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(8rem,14rem)_1fr]',
            // A rule that fails on every row isn't one row among many — it's the file's problem.
            problem.rows.everyRow && 'rounded-md bg-muted/50 p-3',
          )}
        >
          <p class="font-semibold">{formatRowSpan(problem.rows)}</p>
          <div class="space-y-1">
            <p>{problem.rule}.</p>
            {#if problem.advice}
              <p class="text-sm text-muted-foreground">{problem.advice}</p>
            {/if}
            {#if problem.examples.length > 0}
              <div class="flex flex-wrap gap-2">
                {#each problem.examples as example (example)}
                  <span
                    class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                    >{example}</span
                  >
                {/each}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}

  <p class="text-sm text-muted-foreground">No report was created.</p>

  {@render backButton()}
</div>
