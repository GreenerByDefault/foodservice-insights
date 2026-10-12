<script lang="ts">
import { APP_NAME } from '@gbd/core';
import type { Snippet } from 'svelte';
import SiteHeader from './site-header.svelte';

/** The top bar of every page outside the `(app)` gate. */
interface Props {
  /** Pinned to the right edge, e.g. the marketing page's "Sign in". */
  actions?: Snippet;
}

let { actions }: Props = $props();
</script>

<SiteHeader>
  <!-- `/` is right for a signed-in visitor too: it redirects them to `/orgs`. -->
  <a href="/" class="text-sm font-medium">{APP_NAME}</a>
  {#if actions}
    <div class="ml-auto">{@render actions()}</div>
  {/if}
</SiteHeader>
