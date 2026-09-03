<script lang="ts">
import { APP_NAME } from '@gbd/core';
import AppTitle from '$lib/components/app-title.svelte';
import PublicShell from '$lib/components/public-shell.svelte';
import StubNotice from '$lib/components/stub-notice.svelte';
import { Button } from '$lib/components/ui/button/index.js';
</script>

<svelte:head><title>{APP_NAME}</title></svelte:head>

<!-- The marketing page, and the only path `static/robots.txt` lets a crawler have.
     **Stub:** the copy and design are placeholders; GBD comms will supply the real ones. -->
<PublicShell>
  <AppTitle />

  <StubNotice />

  <Button href="/sign-in">Sign in</Button>
</PublicShell>
