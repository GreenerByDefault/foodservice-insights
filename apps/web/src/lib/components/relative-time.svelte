<script lang="ts">
import { formatTimestamp, formatWhen } from '@gbd/core';

interface Props {
  /** The moment being described. Reads as relative ("3 days ago") under a week old, an absolute
   * date beyond that — see `formatWhen`. */
  at: Date;
  /** What "now" is, for computing the relative phrasing — the server's clock, passed down
   * rather than read from the browser, so a stale client clock can't skew the result. */
  now: Date;
  class?: string;
}

let { at, now, class: className }: Props = $props();
</script>

<time datetime={at.toISOString()} title={formatTimestamp(at)} class={className}
  >{formatWhen(now, at)}</time
>
