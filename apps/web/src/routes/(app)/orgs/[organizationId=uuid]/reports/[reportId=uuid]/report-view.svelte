<script lang="ts">
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
import { createPoller } from '$lib/polling/create-poller.svelte';
import { isWaiting } from '$lib/reports/attempt-status';
import type { ReportPageData } from './+page.server.ts';
import CanceledView from './canceled-view.svelte';
import FailureView from './failure-view.svelte';
import { pollReport } from './polling/poll-report.ts';
import ReportHeading from './report-heading.svelte';
import ResultView from './result-view.svelte';
import { describeProgress } from './waiting/progress.ts';
import WaitingView from './waiting/waiting-view.svelte';

let { data }: { data: ReportPageData } = $props();

/** The page's own copy of the report: a writable `$derived`, so the poll moves it, and a new
 * `data` prop resets it.
 *
 * The reset matters because SvelteKit reuses this component across `[reportId]` — navigating from
 * one report to another changes `data` without remounting, and a plain `$state` copy would keep
 * showing the report the user just left. Nothing else replaces `data`: this page is the
 * only writer of its own state, and it writes through the poller (see `./poll/+server.ts` for why
 * `invalidate()` is not used here).
 *
 * A failed poll never touches `current`, so "keep the last known state on screen through an
 * outage" falls out of that rather than needing its own retention logic. */
let current = $derived(data);

let reportSettled = $derived(!isWaiting(current.attempt));
let headline = $derived(screenHeadline(current));

const poller = createPoller({
  poll: () => pollReport(current.pollHref),
  isSettled: () => reportSettled,
  pollIntervalMs: () => current.pollIntervalMs,
  onData: (next) => {
    current = next;
  },
});

/** What the live region announces. */
function screenHeadline(report: ReportPageData): string {
  switch (report.attempt.status) {
    case 'pending':
    case 'processing':
      return describeProgress(report.attempt, report.now).headline;
    case 'succeeded':
      return 'Your report is ready';
    case 'failed':
      return 'Your report could not be finished';
    case 'canceled':
      return 'This report was stopped';
  }
}
</script>

<svelte:head>
  <title>{current.report.name}</title>
</svelte:head>

<ReportHeading
  name={current.report.name}
  siteName={current.report.siteName}
  creator={current.report.creator}
/>

<!-- Outside the switch on purpose so that it is not unmounted when the view changes. -->
<div aria-live="polite" class="sr-only">{headline}</div>

{#if poller.connectionStatus === 'retrying'}
  <Alert>
    <WifiOffIcon />
    <AlertTitle>Reconnecting…</AlertTitle>
    <AlertDescription>
      We lost the connection, but your report is safe — this page will catch up automatically.
    </AlertDescription>
  </Alert>
{/if}

{#if isWaiting(current.attempt)}
  <WaitingView
    attempt={current.attempt}
    now={current.now}
    cancelButtonHref={current.cancelButtonHref}
    onReportChanged={poller.pollNow}
  />
{:else if current.attempt.status === 'succeeded'}
  <ResultView
    finishedAt={current.attempt.finishedAt}
    now={current.now}
    files={current.attempt.files}
    inputFile={current.inputFile}
    deleteAction={current.deleteAction}
  />
{:else if current.attempt.status === 'failed'}
  <FailureView
    attemptNumber={current.attempt.attemptNumber}
    failure={current.attempt.failure}
    retryButtonHref={current.retryButtonHref}
    deleteAction={current.deleteAction}
    onReportChanged={poller.pollNow}
  />
{:else if current.attempt.status === 'canceled'}
  <CanceledView
    stoppedAt={current.attempt.stoppedAt}
    now={current.now}
    newReportHref={current.newReportHref}
    deleteAction={current.deleteAction}
  />
{/if}
