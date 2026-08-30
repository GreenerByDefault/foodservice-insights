<script lang="ts">
import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
import type { DeleteAction } from './+page.server.ts';
import DeleteButton from './delete-button.svelte';
import RelativeTime from './relative-time.svelte';
import StatusLine from './status-line.svelte';

interface Props {
  stoppedAt: Date;
  now: Date;
  newReportHref: string;
  deleteAction: DeleteAction;
}

let { stoppedAt, now, newReportHref, deleteAction }: Props = $props();
</script>

<div class="space-y-4">
  <StatusLine icon={CircleStopIcon}>
    <p class="text-muted-foreground">
      Someone stopped this report <RelativeTime at={stoppedAt} {now} />.
      <a class="underline hover:no-underline" href={newReportHref}>Upload a file</a>
      to start a new one.
    </p>
  </StatusLine>

  <DeleteButton action={deleteAction} />
</div>
