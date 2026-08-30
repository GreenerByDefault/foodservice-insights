<script lang="ts">
import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
import { formatElapsed, formatTimestamp } from '@gbd/core';
import DeleteButton from './delete-button.svelte';

interface Props {
  stoppedAt: Date;
  now: Date;
  newReportHref: string;
  deleteButtonHref: string;
  organizationHref: string;
}

let { stoppedAt, now, newReportHref, deleteButtonHref, organizationHref }: Props = $props();
</script>

<div class="space-y-4">
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

  <DeleteButton {deleteButtonHref} {organizationHref} />
</div>
