<!-- Test-only: `createPoller` needs component-init context (`onMount`, `$effect`), so it can't be
     unit-tested as a bare module. This wraps it in the smallest component that can, rendering
     nothing but the one thing tests observe directly — `connectionStatus`. -->
<script lang="ts">
import { createPoller, type PollerOptions } from '../create-poller.svelte.ts';

let {
  poll,
  settled,
  pollIntervalMs,
  onData,
}: {
  poll: PollerOptions<unknown>['poll'];
  settled: boolean;
  pollIntervalMs: number;
  onData: PollerOptions<unknown>['onData'];
} = $props();

const poller = createPoller({
  poll: () => poll(),
  isSettled: () => settled,
  pollIntervalMs: () => pollIntervalMs,
  onData: (data) => onData(data),
});
</script>

<span data-testid="connection-status">{poller.connectionStatus}</span>
