<script lang="ts">
import { formatElapsed, formatTimestamp } from '@gbd/core';

let { stoppedAt, now, newReportHref }: { stoppedAt: Date; now: Date; newReportHref: string } =
  $props();
</script>

<p class="text-muted-foreground">
  You stopped this report
  <time datetime={stoppedAt.toISOString()} title={formatTimestamp(stoppedAt)}
    >{formatElapsed(now, stoppedAt)}</time
  >.
  <a class="underline hover:no-underline" href={newReportHref}>Upload a file</a>
  to start a new one.
</p>
