<script lang="ts" generics="T">
import type { Snippet } from 'svelte';

interface Props {
  items: readonly T[];
  key: (item: T) => string;
  /** Shown instead of the list when there's nothing to show. */
  empty: string | Snippet;
  children: Snippet<[T]>;
}

let { items, key, empty, children }: Props = $props();
</script>

{#if items.length === 0}
  {#if typeof empty === 'string'}
    <p class="w-full text-muted-foreground">{empty}</p>
  {:else}
    {@render empty()}
  {/if}
{:else}
  <ul class="w-full divide-y border-y">
    {#each items as item (key(item))}
      {@render children(item)}
    {/each}
  </ul>
{/if}
