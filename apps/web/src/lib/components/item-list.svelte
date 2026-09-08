<script lang="ts" generics="T">
import type { Snippet } from 'svelte';

interface Props {
  items: readonly T[];
  key: (item: T) => string;
  /** Shown instead of the list when there's nothing to show. */
  empty: string;
  children: Snippet<[T]>;
}

let { items, key, empty, children }: Props = $props();
</script>

{#if items.length === 0}
  <p class="w-full text-muted-foreground">{empty}</p>
{:else}
  <ul class="w-full divide-y border-y">
    {#each items as item (key(item))}
      {@render children(item)}
    {/each}
  </ul>
{/if}
