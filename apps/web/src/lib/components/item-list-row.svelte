<script lang="ts">
import type { Snippet } from 'svelte';

/** A non-link list row: `children` stacked below `sm`, one line from `sm` up, then optional
 * `actions`. */
interface Props {
  children: Snippet;
  actions?: Snippet;
}

let { children, actions }: Props = $props();
</script>

<!-- `items-center` centers `actions` against the row as a whole, beside all stacked lines below
     `sm`, rather than pinned to one. `flex-wrap` is for an `actions` error message with
     `basis-full`: it never fits beside what's already on the line, so it wraps onto a row of its
     own without shifting anything before it. -->
<li class="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-2 py-3">
  <!-- Stacked below `sm`, where the row is too narrow for both sides to share a line without
       truncating the left hard. -->
  <span
    class="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
  >
    {@render children()}
  </span>
  {@render actions?.()}
</li>
