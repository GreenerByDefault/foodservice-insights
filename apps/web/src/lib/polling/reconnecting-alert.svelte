<script lang="ts">
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';

let { subject }: { subject: 'report' | 'reports' } = $props();

let verb = $derived(subject === 'reports' ? 'are' : 'is');
</script>

<!-- `Alert` is `role="alert"`, which interrupts — deliberately: losing the connection is worth
     it, and callers keep this mounted while retrying, so it speaks once rather than every poll. -->
<Alert>
  <WifiOffIcon />
  <AlertTitle>Reconnecting…</AlertTitle>
  <AlertDescription>
    We lost the connection, but your {subject} {verb} safe — this page will catch up automatically.
  </AlertDescription>
</Alert>
