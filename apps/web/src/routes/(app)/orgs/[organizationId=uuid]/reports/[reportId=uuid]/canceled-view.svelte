<script lang="ts">
import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
import RelativeTime from '$lib/components/reports/relative-time.svelte';
import DeleteButton from './delete-button.svelte';
import StatusLine from './status-line.svelte';

interface Props {
  stoppedAt: Date;
  now: Date;
  newReportHref: string;
  organizationId: string;
  reportId: string;
}

let { stoppedAt, now, newReportHref, organizationId, reportId }: Props = $props();
</script>

<div class="space-y-4">
  <StatusLine icon={CircleStopIcon}>
    <p class="text-muted-foreground">
      Someone stopped this report <RelativeTime at={stoppedAt} {now} />.
      <a class="underline hover:no-underline" href={newReportHref}>Upload a file</a>
      to start a new one.
    </p>
  </StatusLine>

  <DeleteButton {organizationId} {reportId} />
</div>
