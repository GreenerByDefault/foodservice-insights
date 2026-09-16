<script lang="ts">
import { formatTimestamp, formatUntil, formatWhen } from '@gbd/core';

interface Props {
  /** The moment being described. Under a week from `now` reads as relative ("3 days ago" /
   * "in 3 days"); an absolute date beyond that — see `formatWhen` / `formatUntil`. */
  at: Date;
  /** The server's clock, passed down rather than read from the browser, so a stale client
   * clock can't skew the result. */
  now: Date;
  direction: 'past' | 'future';
  class?: string;
}

let { at, now, direction, class: className }: Props = $props();
</script>

<time datetime={at.toISOString()} title={formatTimestamp(at)} class={className}
  >{direction === 'future' ? formatUntil(now, at) : formatWhen(now, at)}</time
>
