import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import FailureView from './failure-view.svelte';
import { atRetryCapFailure, notRetryableFailure, retryableFailure } from './testing/fixtures.ts';

/** Stands in for the polling view's `poll`, which is what the retry button asks for a refresh. */
const onReportChanged = vi.fn(() => Promise.resolve());

const RETRY_HREF = '/api/orgs/org-1/reports/report-1/retry';

const RETRYABLE = retryableFailure();
const NOT_RETRYABLE = notRetryableFailure();
const AT_RETRY_CAP = atRetryCapFailure();

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  onReportChanged.mockClear();
});

describe('FailureView', () => {
  test('renders what happened, the follow-up, and a mailto contact link', async () => {
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });

    await expect.element(screen.getByText(RETRYABLE.whatHappened)).toBeVisible();
    await expect.element(screen.getByText(RETRYABLE.followUpText)).toBeVisible();
    await expect
      .element(screen.getByRole('link', { name: 'Contact us' }))
      .toHaveAttribute('href', RETRYABLE.contactMailto);
  });

  test('the attempt count shows only above 1', async () => {
    const oneAttempt = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });
    await expect
      .element(oneAttempt.getByText('This was attempt', { exact: false }))
      .not.toBeInTheDocument();

    const thirdAttempt = await render(FailureView, {
      attemptNumber: 3,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });
    await expect.element(thirdAttempt.getByText('This was attempt 3.')).toBeVisible();
  });

  test('the attempt count is suppressed once the follow-up already says the attempts are exhausted', async () => {
    const screen = await render(FailureView, {
      attemptNumber: 5,
      failure: AT_RETRY_CAP,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });

    await expect.element(screen.getByText(AT_RETRY_CAP.followUpText)).toBeVisible();
    await expect
      .element(screen.getByText('This was attempt', { exact: false }))
      .not.toBeInTheDocument();
  });

  test('the retry button shows when the failure copy says the follow-up is a retry', async () => {
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });
    await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('the retry button is absent when the follow-up is to contact us instead', async () => {
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: NOT_RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });
    await expect.element(screen.getByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  test('clicking retry calls the endpoint and refreshes just this report', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => onReportChanged.mock.calls.length).toBe(1);
  });

  test('a 409 — another attempt already exists — refreshes rather than showing an error', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'This report cannot be retried right now' }), {
        status: 409,
      }),
    );
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => onReportChanged.mock.calls.length).toBe(1);
    await expect
      .element(screen.getByText('Could not retry this report. Please try again.'))
      .not.toBeInTheDocument();
  });

  test('while the request is in flight, the retry button is disabled', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Retry' }).click();
    await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();

    resolveFetch(new Response(null, { status: 204 }));
    await expect.poll(() => onReportChanged.mock.calls.length).toBe(1);
  });

  test('an unreachable server shows an error and does not refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(FailureView, {
      attemptNumber: 1,
      failure: RETRYABLE,
      retryButtonHref: RETRY_HREF,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Retry' }).click();

    await expect
      .element(screen.getByText('Could not retry this report. Please try again.'))
      .toBeVisible();
    expect(onReportChanged).not.toHaveBeenCalled();
  });
});
