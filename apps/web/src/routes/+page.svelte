<script lang="ts">
import { APP_NAME } from '@gbd/core';
import AppTitle from '$lib/components/app-title.svelte';
import { Button } from '$lib/components/ui/button/index.js';
</script>

<svelte:head><title>{APP_NAME}</title></svelte:head>

<!-- The marketing page, and the only path `static/robots.txt` lets a crawler have. It carries its
     own chrome because the root layout has none and the signed-in header does not belong to a
     stranger.
     **Stub:** the copy and design are placeholders; GBD comms will supply the real ones. -->
<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-8">
  <AppTitle />

  <p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>

  <Button href="/sign-in">Sign in</Button>
</main>
