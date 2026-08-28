<script lang="ts">
import { formatElapsed, formatTimestamp } from '@gbd/core';

let { stoppedAt, now }: { stoppedAt: Date; now: Date } = $props();
</script>

<p class="text-muted-foreground">
  You stopped this report
  <time datetime={stoppedAt.toISOString()} title={formatTimestamp(stoppedAt)}
    >{formatElapsed(now, stoppedAt)}</time
  >. It cannot be run again — upload the file again to start a new report.
</p>
