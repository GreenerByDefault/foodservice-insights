<script lang="ts">
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import type { AnalysisAttemptStatus } from '@gbd/db';

interface Props {
  status: AnalysisAttemptStatus;
}

let { status }: Props = $props();

const LABELS: Record<AnalysisAttemptStatus, string> = {
  pending: 'Queued',
  processing: 'Processing',
  succeeded: 'Ready',
  failed: "Couldn't finish",
  canceled: 'Stopped',
};
</script>

<!-- Weighted text, not a badge: a list of finished reports is overwhelmingly "Ready", so a page
of green badges would spend all its colour on the least informative status and bury the one red
one. Only a failure earns colour. -->
<span class={status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
  {#if status === 'processing'}
    <LoaderCircleIcon class="inline size-4 motion-safe:animate-spin" aria-hidden="true" />
  {/if}
  {LABELS[status]}
</span>
