<script lang="ts">
import { formatTimestamp, formatUntil, formatWhen } from '@gbd/core';

interface Props {
  /** The moment being described. Reads as relative ("3 days ago", or "in 3 days" for `direction:
   * 'future'`) under a week from `now`, an absolute date beyond that — see `formatWhen` /
   * `formatUntil`. */
  at: Date;
  /** What "now" is, for computing the relative phrasing — the server's clock, passed down
   * rather than read from the browser, so a stale client clock can't skew the result. */
  now: Date;
  /** `'past'` (the default) for something that already happened ("3 days ago"); `'future'` for a
   * deadline still ahead ("in 3 days") — an invite's expiry, say. */
  direction?: 'past' | 'future';
  class?: string;
}

let { at, now, direction = 'past', class: className }: Props = $props();
</script>

<time datetime={at.toISOString()} title={formatTimestamp(at)} class={className}
  >{direction === 'future' ? formatUntil(now, at) : formatWhen(now, at)}</time
>
