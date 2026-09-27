<script lang="ts">
import { APP_NAME } from '@gbd/core';
import type { Snippet } from 'svelte';

/** The top bar of every page outside the `(app)` gate. */
interface Props {
  /** Pinned to the right edge, e.g. the marketing page's "Sign in". */
  actions?: Snippet;
}

let { actions }: Props = $props();
</script>

<header class="border-b">
  <!-- `min-h-15` is the height a button gives the bar, held without one so it doesn't shrink from
       the marketing page to sign-in. -->
  <div class="mx-auto flex min-h-15 w-full max-w-4xl items-center gap-3 px-6 py-3 sm:px-8">
    <!-- `/` is right for a signed-in visitor too: it redirects them to `/orgs`. -->
    <a href="/" class="text-sm font-medium">{APP_NAME}</a>
    {#if actions}
      <div class="ml-auto">{@render actions()}</div>
    {/if}
  </div>
</header>
