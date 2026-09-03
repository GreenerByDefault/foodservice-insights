<script lang="ts">
import { createPoller } from '$lib/polling/create-poller.svelte';
import ReconnectingAlert from '$lib/polling/reconnecting-alert.svelte';
import { isWaiting } from '$lib/reports/attempt-status';
import type { ReportListRow, ReportsPageData } from './+page.server.ts';
import { pollReports } from './poll-reports.ts';
import ReportsList from './reports-list.svelte';
import ReportsPagination from './reports-pagination.svelte';

let { data }: { data: ReportsPageData } = $props();

/** The page's own copy of the list: a writable `$derived`, so the poll moves it, and a new
 * `data` prop (paging to an older/newer page) resets it — see `report-view.svelte`'s identical
 * comment for why this is the only writer of its own state. */
let current = $derived(data);

let anySettling = $derived(current.reports.some((report) => isWaiting(report)));
let announcement = $state('');

const poller = createPoller({
  // Only the ids already on screen — see `_loadReportsByIds`'s doc comment for why a poll never
  // adds or removes rows, just refreshes the ones the client already has.
  poll: () =>
    pollReports(
      current.pollHref,
      current.reports.map((report) => report.id),
    ),
  isSettled: () => !anySettling,
  pollIntervalMs: () => current.pollIntervalMs,
  onData: (next) => {
    announcement = settledAnnouncement(current.reports, next.reports);
    current = { ...current, reports: mergeReports(current.reports, next.reports) };
  },
});

/** Keeps the screen's own row order and drops any id the poll didn't return — a soft delete, or a
 * move out of this organization, since the last poll. */
function mergeReports(onScreen: ReportListRow[], polled: ReportListRow[]): ReportListRow[] {
  const byId = new Map(polled.map((report) => [report.id, report]));
  return onScreen.flatMap((report) => byId.get(report.id) ?? []);
}

/** Names only the reports that just finished, rather than restating the whole list — which would
 * be chatty when several finish at once. */
function settledAnnouncement(previous: ReportListRow[], next: ReportListRow[]): string {
  const justSettled = next.filter((report) => {
    const before = previous.find((row) => row.id === report.id);
    return before !== undefined && isWaiting(before) && !isWaiting(report);
  });
  return justSettled.map((report) => `${report.name} ${settledCopy(report.status)}`).join('. ');
}

function settledCopy(status: ReportListRow['status']): string {
  switch (status) {
    case 'succeeded':
      return 'is ready';
    case 'failed':
      return "couldn't finish";
    case 'canceled':
      return 'was stopped';
    case 'pending':
    case 'processing':
      throw new Error('unreachable: settledAnnouncement only calls this for a settled status');
  }
}
</script>

<!-- Outside the switch on purpose so that it is not unmounted when the list changes. -->
<div aria-live="polite" class="sr-only">{announcement}</div>

{#if poller.connectionStatus === 'retrying'}
  <ReconnectingAlert subject="reports" />
{/if}

<ReportsList reports={current.reports} />
<ReportsPagination olderHref={current.olderHref} newerHref={current.newerHref} />
