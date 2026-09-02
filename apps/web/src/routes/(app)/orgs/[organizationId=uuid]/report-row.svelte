<script lang="ts">
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import RelativeTime from '$lib/components/reports/relative-time.svelte';
import { subheading } from '$lib/reports/subheading';
import type { ReportListRow } from './+page.server.ts';
import ReportStatus from './report-status.svelte';

interface Props {
  report: ReportListRow;
}

let { report }: Props = $props();

let reportSubheading = $derived(subheading(report.siteName, report.creator));
</script>

<li>
  <a
    href={report.href}
    class="flex w-full flex-col gap-1 px-2 py-3 hover:bg-accent focus-visible:bg-accent"
  >
    <span class="flex items-center justify-between gap-4">
      <span class="min-w-0 truncate font-medium" title={report.name}>{report.name}</span>
      <!-- Status and chevron share one flex line so they sit on the same baseline instead of the
      chevron centering on the row's full two-line height, which put it between the lines rather
      than level with the status text it's paired with. -->
      <span class="flex shrink-0 items-center gap-2">
        <ReportStatus status={report.status} />
        <ChevronRightIcon
          class="size-5 text-muted-foreground"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </span>
    </span>
    <span class="truncate text-sm text-muted-foreground" title={reportSubheading}
      >{reportSubheading}
      · <RelativeTime at={report.createdAt} now={report.now} /></span
    >
  </a>
</li>
