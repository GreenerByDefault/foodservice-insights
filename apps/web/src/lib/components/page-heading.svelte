<script lang="ts">
import type { Snippet } from 'svelte';

/** The `<h1>` a page opens with. */
interface Props {
  children: Snippet;
  /** Beside the heading on `sm+`, below it on mobile, e.g. a list page's "New" button. */
  actions?: Snippet;
}

let { children, actions }: Props = $props();
</script>

{#snippet heading()}
  <!-- `tabindex="-1"`: lets `focusPageHeading` land focus here without adding a tab stop. -->
  <h1 tabindex="-1" class="text-3xl font-medium">{@render children()}</h1>
{/snippet}

{#if actions}
  <!-- Stacks on mobile: a long heading beside a button would overflow. -->
  <div
    class="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
  >
    {@render heading()}
    {@render actions()}
  </div>
{:else}
  {@render heading()}
{/if}
