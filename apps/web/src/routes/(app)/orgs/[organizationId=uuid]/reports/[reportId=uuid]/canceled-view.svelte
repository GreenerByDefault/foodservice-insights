<script lang="ts">
import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
import { formatElapsed, formatTimestamp } from '@gbd/core';

interface Props {
  stoppedAt: Date;
  now: Date;
  newReportHref: string;
}

let { stoppedAt, now, newReportHref }: Props = $props();
</script>

<div class="flex gap-3">
  <CircleStopIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  <p class="text-muted-foreground">
    You stopped this report
    <time datetime={stoppedAt.toISOString()} title={formatTimestamp(stoppedAt)}
      >{formatElapsed(now, stoppedAt)}</time
    >.
    <a class="underline hover:no-underline" href={newReportHref}>Upload a file</a>
    to start a new one.
  </p>
</div>
