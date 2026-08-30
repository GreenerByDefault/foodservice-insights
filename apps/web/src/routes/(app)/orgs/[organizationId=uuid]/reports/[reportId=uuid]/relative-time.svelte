<script lang="ts">
import { formatElapsed, formatTimestamp } from '@gbd/core';

interface Props {
  /** The moment being described. */
  at: Date;
  /** The database's clock, not the browser's — see `ReportPageData.now`. */
  now: Date;
  class?: string;
}

let { at, now, class: className }: Props = $props();
</script>

<time datetime={at.toISOString()} title={formatTimestamp(at)} class={className}
  >{formatElapsed(now, at)}</time
>
