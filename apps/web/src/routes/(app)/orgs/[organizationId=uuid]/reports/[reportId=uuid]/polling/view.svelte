<script lang="ts">
import { onMount, untrack } from 'svelte';
import type { ReportPageData } from '../+page.server.ts';
import CanceledView from '../canceled-view.svelte';
import FailureView from '../failure-view.svelte';
import ResultView from '../result/view.svelte';
import { describeProgress, isWaiting } from '../waiting/progress.ts';
import WaitingView from '../waiting/view.svelte';
import { pollReport } from './poll-report.ts';
import { FAILURES_BEFORE_NOTICE, nextPollDelayMs } from './schedule.ts';

let { data }: { data: ReportPageData } = $props();

/** The page's own copy of the report: a writable `$derived`, so the poll moves it, and a new
 * `data` prop resets it.
 *
 * The reset matters because SvelteKit reuses this component across `[reportId]` — navigating from
 * one report to another changes `data` without remounting, and a plain `$state` copy would keep
 * showing the report the user just left. Nothing else replaces `data` anymore: this page is the
 * only writer of its own state, and it writes through `poll` (see `../poll/+server.ts` for why
 * `invalidate()` is not used here).
 *
 * A failed poll never touches `current`, so "keep the last known state on screen through an
 * outage" falls out of that rather than needing its own retention logic. */
let current = $derived(data);

let consecutiveFailures = $state(0);
let hidden = $state(false);

let settled = $derived(!isWaiting(current.attempt));
let connection = $derived<'ok' | 'retrying'>(
  consecutiveFailures >= FAILURES_BEFORE_NOTICE ? 'retrying' : 'ok',
);
let headline = $derived(screenHeadline(current));

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleNext(): void {
  clearTimeout(timer);
  const delayMs = nextPollDelayMs({ settled, hidden, consecutiveFailures });
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

/** Starts and stops the loop above, which cannot do either for itself: each poll arms the next
 * one, so the chain keeps going once it is going, but nothing in it notices a report that becomes
 * pollable again from a standstill — a retry turning a settled report back into a waiting one, or
 * a navigation from a finished report to a running one.
 *
 * `untrack` keeps the dependencies to exactly the two conditions in the guard. `scheduleNext` also
 * reads `consecutiveFailures`, and re-running this on every failed poll would only fight the
 * backoff the chain is already applying. */
$effect(() => {
  if (settled || hidden) {
    clearTimeout(timer);
    timer = undefined;
    return;
  }
  untrack(scheduleNext);
});

function onVisibilityChange(): void {
  hidden = document.hidden;
  // Catch up right away rather than waiting out the delay the effect above is arming.
  if (!hidden && !settled) poll();
}

onMount(() => {
  hidden = document.hidden;
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

<h1 class="text-2xl font-semibold tracking-tight">{current.report.name}</h1>

<!-- Outside the switch on purpose so that it is not unmounted when the view changes. -->
<div aria-live="polite" class="sr-only">{headline}</div>

{#if connection === 'retrying'}
  <p class="text-sm text-muted-foreground" role="status">
    Having trouble reaching the server. Your report is safe — this page will catch up once we
    reconnect.
  </p>
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
    files={current.attempt.files}
    inputFile={current.inputFile}
  />
{:else if current.attempt.status === 'failed'}
  <FailureView
    attemptNumber={current.attempt.attemptNumber}
    failure={current.attempt.failure}
    retryButtonHref={current.retryButtonHref}
    onReportChanged={poll}
  />
{:else if current.attempt.status === 'canceled'}
  <CanceledView
    stoppedAt={current.attempt.stoppedAt}
    now={current.now}
    newReportHref={current.newReportHref}
  />
{/if}
