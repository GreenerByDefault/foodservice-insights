<script lang="ts">
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import { describeProgress, type WaitingAttempt } from './progress.ts';
import Timeline from './timeline.svelte';

let { attempt, now }: { attempt: WaitingAttempt; now: Date } = $props();

let progress = $derived(describeProgress(attempt, now));
</script>

<div class="space-y-6">
  <div class="flex items-start gap-3">
    <LoaderCircleIcon
      class="mt-1 size-5 shrink-0 text-primary motion-safe:animate-spin"
      aria-hidden="true"
    />
    <div>
      <h2 class="text-lg font-semibold tracking-tight">{progress.headline}</h2>
      {#if progress.body}
        <p class="text-muted-foreground text-sm">{progress.body}</p>
      {/if}
    </div>
  </div>

  <p class="text-muted-foreground text-sm">
    You can close this page. We will email you when your report is ready.
  </p>

  <Timeline steps={progress.steps} {now} />
</div>
