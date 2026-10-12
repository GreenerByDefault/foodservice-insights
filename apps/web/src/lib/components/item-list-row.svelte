<script lang="ts">
import type { Snippet } from 'svelte';

/** A non-link list row: `children` stacked below `sm` and on one line from `sm` up, with optional
 * `actions` after it. The members page renders two of these, one above the other.
 *
 * `items-center` centers `actions` against the row as a whole — beside all stacked lines below
 * `sm` — rather than pinned to one of them. `flex-wrap` is for an `actions` error message with
 * `basis-full`: a flex item asking for the row's full width never fits next to what's already on
 * the line, so it wraps onto a row of its own below, without shifting anything before it. */
interface Props {
  children: Snippet;
  actions?: Snippet;
}

let { children, actions }: Props = $props();
</script>

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
