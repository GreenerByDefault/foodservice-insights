<script lang="ts">
import type { Snippet } from 'svelte';

/** The `<h1>` a page opens with. */
interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<!-- `tabindex="-1"`: lets `focusPageHeading` land focus here without adding a tab stop. -->
<h1 tabindex="-1" class="text-2xl font-semibold tracking-tight">{@render children()}</h1>
