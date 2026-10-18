<script lang="ts">
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import type { AnalysisAttemptStatus } from '@gbd/db';
import { STATUS_LABELS } from '#lib/reports/status-copy.js';

interface Props {
  status: AnalysisAttemptStatus;
}

let { status }: Props = $props();

const STATUS_COLORS: Record<AnalysisAttemptStatus, string> = {
  pending: 'text-muted-foreground',
  processing: 'text-muted-foreground',
  succeeded: 'text-primary',
  failed: 'text-destructive',
  canceled: 'text-muted-foreground',
};
</script>

<span class={STATUS_COLORS[status]}>
  {#if status === 'processing'}
    <LoaderCircleIcon class="inline size-4 motion-safe:animate-spin" aria-hidden="true" />
  {/if}
  {STATUS_LABELS[status]}
</span>
