<script lang="ts">
import CancelButton from './cancel-button.svelte';
import { describeProgress, type WaitingAttempt } from './progress.ts';
import Timeline from './timeline.svelte';

let { attempt, now, cancelHref }: { attempt: WaitingAttempt; now: Date; cancelHref: string } =
  $props();

let progress = $derived(describeProgress(attempt, now));
</script>

<div class="space-y-6">
  <Timeline steps={progress.steps} {now} />

  <p class="text-muted-foreground text-sm">
    You can close this page. We will email you when your report is ready.
  </p>

  <CancelButton {cancelHref} />
</div>
