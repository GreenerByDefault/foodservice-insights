<script lang="ts">
import type { Snippet } from 'svelte';

/** The top bar of every page, inside the `(app)` gate and out. */
interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<header class="border-b">
  <!-- `min-h-15` is the height a button gives the bar, held without one so it doesn't shrink from
       the marketing page to sign-in. -->
  <div class="page-width flex min-h-15 items-center gap-3 py-3">
    {@render children()}
  </div>
</header>
