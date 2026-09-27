<script lang="ts">
import type { Snippet } from 'svelte';

/** The `<h1>` a page opens with. */
interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<h1 class="text-2xl font-semibold tracking-tight">{@render children()}</h1>
