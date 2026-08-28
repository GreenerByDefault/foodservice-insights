<script lang="ts">
import { describeProgress, type WaitingAttempt } from './progress.ts';
import Timeline from './timeline.svelte';

let { attempt, now }: { attempt: WaitingAttempt; now: Date } = $props();

let progress = $derived(describeProgress(attempt, now));
</script>

<!-- No separate headline above the timeline: the current step's icon and bold title already say
     what's happening, and a second copy of the same words read as noise. -->
<div class="space-y-6">
  <Timeline steps={progress.steps} {now} />

  <p class="text-muted-foreground text-sm">
    You can close this page. We will email you when your report is ready.
  </p>
</div>
