<script lang="ts">
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';

let { subject }: { subject: 'report' | 'reports' } = $props();

let verb = $derived(subject === 'reports' ? 'are' : 'is');
</script>

<!-- `Alert` is `role="alert"`, which interrupts a screen reader. For now we judge losing the
     connection worth that, and it speaks once, not every poll: callers keep it mounted while
     retrying. If it proves noisy, `role="status"` is the polite alternative. -->
<Alert>
  <WifiOffIcon />
  <AlertTitle>Reconnecting…</AlertTitle>
  <AlertDescription>
    We lost the connection, but your {subject} {verb} safe — this page will catch up automatically.
  </AlertDescription>
</Alert>
