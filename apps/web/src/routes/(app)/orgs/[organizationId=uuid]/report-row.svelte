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
  <a href={report.href} class="flex w-full px-2 py-3 hover:bg-accent focus-visible:bg-accent">
    <!-- The tablet/desktop entry, which uses only two rows. -->
    <span class="hidden w-full flex-col gap-1 sm:flex">
      <span class="flex items-center justify-between gap-4">
        <span class="min-w-0 truncate font-medium" title={report.name}>{report.name}</span>
        <!-- Status and chevron share one flex line so they sit on the same baseline. -->
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
    </span>
    <!-- The mobile entry, which uses four rows. -->
    <span class="flex w-full flex-col gap-1 sm:hidden">
      <span class="flex items-center justify-between gap-4">
        <span class="min-w-0 truncate font-medium" title={report.name}>{report.name}</span>
        <ChevronRightIcon
          class="size-5 shrink-0 text-muted-foreground"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </span>
      <ReportStatus status={report.status} />
      <span class="truncate text-sm text-muted-foreground" title={reportSubheading}
        >{reportSubheading}</span
      >
      <RelativeTime at={report.createdAt} now={report.now} class="text-sm text-muted-foreground" />
    </span>
  </a>
</li>
