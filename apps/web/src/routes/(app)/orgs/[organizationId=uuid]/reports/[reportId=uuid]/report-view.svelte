<script lang="ts">
import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
import { onMount, untrack } from 'svelte';
import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
import type { ReportPageData } from './+page.server.ts';
import CanceledView from './canceled-view.svelte';
import FailureView from './failure-view.svelte';
import { pollReport } from './polling/poll-report.ts';
import { FAILURES_BEFORE_NOTICE, nextPollDelayMs } from './polling/schedule.ts';
import ReportHeading from './report-heading.svelte';
import ResultView from './result-view.svelte';
import { describeProgress, isWaiting } from './waiting/progress.ts';
import WaitingView from './waiting/view.svelte';

let { data }: { data: ReportPageData } = $props();

/** The page's own copy of the report: a writable `$derived`, so the poll moves it, and a new
 * `data` prop resets it.
 *
 * The reset matters because SvelteKit reuses this component across `[reportId]` — navigating from
 * one report to another changes `data` without remounting, and a plain `$state` copy would keep
 * showing the report the user just left. Nothing else replaces `data`: this page is the
 * only writer of its own state, and it writes through `poll` (see `./poll/+server.ts` for why
 * `invalidate()` is not used here).
 *
 * A failed poll never touches `current`, so "keep the last known state on screen through an
 * outage" falls out of that rather than needing its own retention logic. */
let current = $derived(data);

let consecutiveFailures = $state(0);
let documentHidden = $state(false);

let reportSettled = $derived(!isWaiting(current.attempt));
let connectionStatus = $derived<'ok' | 'retrying'>(
  consecutiveFailures >= FAILURES_BEFORE_NOTICE ? 'retrying' : 'ok',
);
let headline = $derived(screenHeadline(current));

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleNext(): void {
  clearTimeout(timer);
  const delayMs = nextPollDelayMs({ reportSettled, documentHidden, consecutiveFailures });
  timer = delayMs === undefined ? undefined : setTimeout(poll, delayMs);
}

async function poll(): Promise<void> {
  try {
    current = await pollReport(current.pollHref);
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures += 1;
  } finally {
    scheduleNext();
  }
}

/** Starts and stops the loop above, which cannot do either for itself. Each poll arms the next
 * one, so the chain keeps going once it is going. But nothing in it notices a report that
 * becomes pollable again from a standstill — a retry turning a settled report back into a
 * waiting one, or a navigation from a finished report to a running one. */
$effect(() => {
  if (reportSettled || documentHidden) {
    clearTimeout(timer);
    timer = undefined;
    return;
  }
  // untrack keeps the dependencies to exactly the two conditions above. scheduleNext also reads
  // consecutiveFailures, and re-running this on every failed poll would fight the backoff the
  // chain is already applying.
  untrack(scheduleNext);
});

function onVisibilityChange(): void {
  documentHidden = document.hidden;
  // Catch up right away rather than waiting out the delay the effect above is arming.
  if (!documentHidden && !reportSettled) poll();
}

onMount(() => {
  documentHidden = document.hidden;
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
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

{#if connectionStatus === 'retrying'}
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
    onReportChanged={poll}
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
    onReportChanged={poll}
  />
{:else if current.attempt.status === 'canceled'}
  <CanceledView
    stoppedAt={current.attempt.stoppedAt}
    now={current.now}
    newReportHref={current.newReportHref}
    deleteAction={current.deleteAction}
  />
{/if}
