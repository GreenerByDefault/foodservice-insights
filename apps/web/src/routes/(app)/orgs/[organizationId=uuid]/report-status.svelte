<script lang="ts">
import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
import type { AnalysisAttemptStatus } from '@gbd/db';
import { STATUS_LABELS } from '$lib/reports/status-copy';

interface Props {
  status: AnalysisAttemptStatus;
}

let { status }: Props = $props();
</script>

<span class={status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
  {#if status === 'processing'}
    <LoaderCircleIcon class="inline size-4 motion-safe:animate-spin" aria-hidden="true" />
  {/if}
  {STATUS_LABELS[status]}
</span>
