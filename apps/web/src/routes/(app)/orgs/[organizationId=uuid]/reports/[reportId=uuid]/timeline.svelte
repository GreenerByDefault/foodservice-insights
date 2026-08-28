<script lang="ts">
import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
import CircleIcon from '@lucide/svelte/icons/circle';
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import { formatElapsed, type Step } from './progress.ts';

let { steps, now }: { steps: Step[]; now: Date } = $props();
</script>

<ol class="space-y-4">
  {#each steps as step (step.stage)}
    <li aria-current={step.current ? 'step' : undefined} class="flex gap-3">
      {#if step.completedAt}
        <CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      {:else if step.current}
        <LoaderCircleIcon
          class="mt-0.5 size-4 shrink-0 text-primary motion-safe:animate-spin"
          aria-hidden="true"
        />
      {:else}
        <CircleIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <div>
        <p class={step.current ? 'font-medium' : 'text-muted-foreground'}>{step.title}</p>
        {#if step.completedAt}
          <time datetime={step.completedAt.toISOString()} class="text-xs text-muted-foreground">
            {formatElapsed(now, step.completedAt)}
          </time>
        {/if}
        {#if step.description}
          <p class="text-muted-foreground text-sm">{step.description}</p>
        {/if}
        {#if step.warning}
          <p class="mt-1 text-sm text-amber-700 dark:text-amber-500">{step.warning}</p>
        {/if}
      </div>
    </li>
  {/each}
</ol>
