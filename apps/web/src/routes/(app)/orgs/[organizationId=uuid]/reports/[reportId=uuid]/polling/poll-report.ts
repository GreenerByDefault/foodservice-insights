/** The client side of `../poll/+server.ts`: fetches it and turns the JSON back into the same
 * `ReportPageData` shape `+page.server.ts` renders with.
 *
 * Dates travel as ISO strings over the wire — `JSON.stringify` does that to a `Date` for free —
 * so this is the one place that puts them back. Trusting the shape rather than validating it at
 * runtime is deliberate: this is our own endpoint, from the same deploy, not third-party input.
 */

import { apiCall } from '$lib/api/fetch';
import type { Attempt, FailureCopy, ReportPageData, ResultFiles } from '../+page.server.ts';

type WireAttempt =
  | { status: 'pending'; createdAt: string }
  | { status: 'processing'; createdAt: string; claimedAt: string }
  | {
      status: 'succeeded';
      createdAt: string;
      claimedAt: string;
      finishedAt: string;
      files: ResultFiles;
    }
  | { status: 'failed'; finishedAt: string; attemptNumber: number; failure: FailureCopy }
  | { status: 'canceled'; stoppedAt: string };

type WireReportPageData = Omit<ReportPageData, 'now' | 'attempt'> & {
  now: string;
  attempt: WireAttempt;
};

/** Throws `ApiError` on a non-2xx response, `ApiUnreachableError` if none arrived — see
 * `$lib/api/fetch.ts`. */
export async function pollReport(pollHref: string): Promise<ReportPageData> {
  const response = await apiCall(pollHref);
  const wire: WireReportPageData = await response.json();
  return { ...wire, now: new Date(wire.now), attempt: reviveAttempt(wire.attempt) };
}

function reviveAttempt(attempt: WireAttempt): Attempt {
  switch (attempt.status) {
    case 'pending':
      return { ...attempt, createdAt: new Date(attempt.createdAt) };
    case 'processing':
      return {
        ...attempt,
        createdAt: new Date(attempt.createdAt),
        claimedAt: new Date(attempt.claimedAt),
      };
    case 'succeeded':
      return {
        ...attempt,
        createdAt: new Date(attempt.createdAt),
        claimedAt: new Date(attempt.claimedAt),
        finishedAt: new Date(attempt.finishedAt),
      };
    case 'failed':
      return { ...attempt, finishedAt: new Date(attempt.finishedAt) };
    case 'canceled':
      return { ...attempt, stoppedAt: new Date(attempt.stoppedAt) };
  }
}
