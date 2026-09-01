<script lang="ts">
import { Button } from '$lib/components/ui/button';
import { formatRows } from '$lib/reports/csv/describe';
import type { UploadRejection } from '$lib/reports/rejection';

// Correct and usable, not designed — the locator/body grid, the date-order emphasis, and the
// rest of the layout in the plan's "What a rejection actually looks like" arrive in PR 2. This
// never switches on `reason`: everything it renders comes from the payload, which is why a
// rate-limit rejection needs no special case here.
let { rejection, onBack }: { rejection: UploadRejection; onBack: () => void } = $props();
</script>

<div class="space-y-4">
  <h2 class="text-lg font-semibold">{rejection.summary}</h2>

  {#if rejection.dateOrderProblem}
    <p>{rejection.dateOrderProblem}</p>
  {/if}

  {#if rejection.rowProblems}
    <ol class="space-y-3">
      {#each rejection.rowProblems as problem, index (index)}
        <li>
          <p>
            <strong>{formatRows(problem.rows)}:</strong>
            {problem.rule}.
          </p>
          {#if problem.advice}
            <p class="text-sm text-muted-foreground">{problem.advice}</p>
          {/if}
          {#if problem.examples.length > 0}
            <p class="font-mono text-sm text-muted-foreground">{problem.examples.join('  ')}</p>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  <p class="text-sm text-muted-foreground">No report was created.</p>

  <Button onclick={onBack}>Back to the form</Button>
</div>
