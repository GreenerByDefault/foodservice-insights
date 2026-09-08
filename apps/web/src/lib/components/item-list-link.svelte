<script lang="ts">
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import type { Snippet } from 'svelte';

interface Props {
  href: string;
  /** False when the row's own content already places a chevron itself — report-row's responsive
   * variants each need theirs inline, next to the status badge or the name, rather than at the
   * row's true end. */
  chevron?: boolean;
  children: Snippet;
}

let { href, chevron = true, children }: Props = $props();
</script>

<li>
  <a
    {href}
    class="flex w-full items-center justify-between gap-4 px-2 py-3 hover:bg-accent focus-visible:bg-accent"
  >
    {@render children()}
    {#if chevron}
      <ChevronRightIcon
        class="size-5 shrink-0 text-muted-foreground"
        strokeWidth={2.5}
        aria-hidden="true"
      />
    {/if}
  </a>
</li>
