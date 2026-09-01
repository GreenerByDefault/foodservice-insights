<script lang="ts">
import RelativeTime from '$lib/components/reports/relative-time.svelte';
import type { ReportListRow } from './+page.server.ts';
import ReportStatus from './report-status.svelte';

interface Props {
  report: ReportListRow;
}

let { report }: Props = $props();

// Copied from report-heading.svelte's creatorName/subheading rather than shared, since the only
// difference here is the relative time appended after it.
function creatorName(creator: ReportListRow['creator']): string {
  if (creator === null) return 'a deleted user';
  return creator.displayName ?? creator.email;
}

function subheading(report: ReportListRow): string {
  const parts = [
    ...(report.siteName ? [report.siteName] : []),
    `Created by ${creatorName(report.creator)}`,
  ];
  return parts.join(' · ');
}
</script>

<li>
  <a
    href={report.href}
    class="flex w-full flex-col gap-1 px-2 py-3 hover:bg-accent focus-visible:bg-accent"
  >
    <span class="flex items-baseline justify-between gap-4">
      <span class="truncate font-medium">{report.name}</span>
      <ReportStatus status={report.status} />
    </span>
    <span class="truncate text-sm text-muted-foreground"
      >{subheading(report)}
      · <RelativeTime at={report.createdAt} now={report.now} /></span
    >
  </a>
</li>
