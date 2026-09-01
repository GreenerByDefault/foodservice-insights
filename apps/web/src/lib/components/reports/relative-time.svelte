<script lang="ts">
import { formatTimestamp, formatWhen } from '@gbd/core';

interface Props {
  /** The moment being described. Reads as relative ("3 days ago") under a week old, an absolute
   * date beyond that — see `formatWhen`. */
  at: Date;
  /** The database's clock, not the browser's — see `ReportPageData.now`. */
  now: Date;
  class?: string;
}

let { at, now, class: className }: Props = $props();
</script>

<time datetime={at.toISOString()} title={formatTimestamp(at)} class={className}
  >{formatWhen(now, at)}</time
>
