<script lang="ts">
import type { Snippet } from 'svelte';
import SiteHeader from './site-header.svelte';
import Wordmark from './wordmark.svelte';

/** The top bar of every page outside the `(app)` gate. */
interface Props {
  /** Pinned to the right edge, e.g. the marketing page's "Sign in". */
  actions?: Snippet;
}

let { actions }: Props = $props();
</script>

<SiteHeader>
  <Wordmark />
  {#if actions}
    <div class="ml-auto">{@render actions()}</div>
  {/if}
</SiteHeader>
