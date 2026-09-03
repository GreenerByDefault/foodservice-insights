<script lang="ts">
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';

let { subject }: { subject: 'report' | 'reports' } = $props();

let verb = $derived(subject === 'reports' ? 'are' : 'is');
</script>

<Alert>
  <WifiOffIcon />
  <AlertTitle>Reconnecting…</AlertTitle>
  <AlertDescription>
    We lost the connection, but your {subject} {verb} safe — this page will catch up automatically.
  </AlertDescription>
</Alert>
