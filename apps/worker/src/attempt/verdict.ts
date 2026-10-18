/** What a child's ending *means*.
 *
 * Keep this file side-effect free to facilitate testing.
 */

import type { AnalysisFailureReason } from '@gbd/db';
import { type ChildOutcome, STDERR_TAIL_BYTES } from '../child/spawn.ts';
import {
  type ChildFailure,
  type ChildResult,
  ContractError,
  type NewCategorizations,
} from '../contract/messages.ts';
import { EXIT_CODES } from '../contract/names.ts';
import { describe } from '../failures.ts';

/** Why the parent ended the child. */
export type Kill =
  | { reason: 'canceled' }
  | { reason: 'hung' }
  | { reason: 'hard-timeout' }
  | { reason: 'shutting-down' }
  | { reason: 'fenced' }
  | { reason: 'lost' }
  | { reason: 'contract-violation'; detail: string };

/** What we learned trying to read the documents the child's exit code says it should
 * have written according to the worker contract.
 */
export type DocumentRead =
  | {
      kind: 'result';
      result: ChildResult;
      missingResultFiles: readonly string[];
      newCategorizations: NewCategorizations['rows'] | undefined;
    }
  | { kind: 'failure'; failure: ChildFailure }
  | { kind: 'read-error'; error: unknown }
  | { kind: 'not-read' };

export type ChildEnding = {
  outcome: ChildOutcome;
  read: DocumentRead;
  kill?: Kill;
};

export type Verdict =
  | { kind: 'succeeded'; result: ChildResult; newCategorizations: NewCategorizations['rows'] }
  | { kind: 'failed'; reason: AnalysisFailureReason; detail: string }
  | { kind: 'canceled' }
  /** The attempt was fenced or reaped. */
  | { kind: 'unowned' };

export function classifyVerdict(ending: ChildEnding): Verdict {
  const verdict = classify(ending);
  return verdict.kind === 'failed' ? { ...verdict, detail: truncate(verdict.detail) } : verdict;
}

function classify(ending: ChildEnding): Verdict {
  const { outcome, read, kill } = ending;

  // Checked before the child's own verdict: `canceled` is the user's explicit intent, and
  // `fenced`/`lost` are attempts we may no longer write to at all.
  if (kill?.reason === 'fenced' || kill?.reason === 'lost') return { kind: 'unowned' };
  if (kill?.reason === 'canceled') return { kind: 'canceled' };
  if (outcome.kind === 'spawn-failed') {
    return {
      kind: 'failed',
      reason: 'infrastructure',
      detail: `could not start the child: ${describe(outcome.error)}`,
    };
  }

  // Safe to check before `kill` below: this requires `outcome.kind === 'exited'`. A child that
  // wrote `result.json` and then hung dies by signal instead, so it never matches here — it
  // falls through to `hung` further down.
  if (
    outcome.kind === 'exited' &&
    outcome.exitCode === 0 &&
    read.kind === 'result' &&
    read.missingResultFiles.length === 0 &&
    read.newCategorizations !== undefined
  ) {
    return { kind: 'succeeded', result: read.result, newCategorizations: read.newCategorizations };
  }
  if (outcome.kind === 'exited' && outcome.exitCode === 1 && read.kind === 'failure') {
    const { reason, detail, traceback } = read.failure;
    return {
      kind: 'failed',
      reason,
      detail: reason === 'unknown' ? withTraceback(detail, traceback) : detail,
    };
  }

  if (kill !== undefined) {
    switch (kill.reason) {
      case 'hung':
        return { kind: 'failed', reason: 'hung', detail: 'no progress within the allotted time' };
      case 'hard-timeout':
        return { kind: 'failed', reason: 'hard_timeout', detail: 'exceeded the hard ceiling' };
      case 'shutting-down':
        return {
          kind: 'failed',
          reason: 'shut_down',
          detail: 'killed while the worker was shutting down',
        };
      case 'contract-violation':
        return { kind: 'failed', reason: 'contract_violation', detail: kill.detail };
    }
  }

  if (read.kind === 'read-error') {
    return read.error instanceof ContractError
      ? { kind: 'failed', reason: 'contract_violation', detail: read.error.message }
      : { kind: 'failed', reason: 'infrastructure', detail: describe(read.error) };
  }

  if (outcome.kind === 'exited' && outcome.exitCode === EXIT_CODES.wroteResult) {
    return { kind: 'failed', reason: 'contract_violation', detail: incompleteResultDetail(read) };
  }
  if (outcome.kind === 'exited' && outcome.exitCode === EXIT_CODES.wroteFailure) {
    return {
      kind: 'failed',
      reason: 'contract_violation',
      detail: 'exited 1 without writing failure.json',
    };
  }
  if (outcome.kind === 'exited' && outcome.exitCode === EXIT_CODES.usageError) {
    return {
      kind: 'failed',
      reason: 'contract_violation',
      detail: crashDetail('invoked with the wrong arguments', outcome.stderrTail),
    };
  }

  return outcome.kind === 'signaled'
    ? {
        kind: 'failed',
        reason: 'child_crashed',
        detail: crashDetail(`killed by signal ${outcome.signal}`, outcome.stderrTail),
      }
    : {
        kind: 'failed',
        reason: 'child_crashed',
        detail: crashDetail(`exited with code ${outcome.exitCode}`, outcome.stderrTail),
      };
}

function incompleteResultDetail(read: DocumentRead): string {
  if (read.kind !== 'result') return 'exited 0 without writing result.json';
  if (read.missingResultFiles.length > 0) {
    return `result.json declared file(s) never written: ${read.missingResultFiles.join(', ')}`;
  }
  return 'exited 0 without writing new-categorizations.json';
}

function crashDetail(head: string, stderrTail: string): string {
  return stderrTail.length > 0 ? `${head}\n${stderrTail}` : head;
}

/** `unknown` is the one reason whose detail (`str(error)`) does not say where it was raised.
 * Truncation keeps the traceback's end, which names the raising line, rather than its start.
 */
function withTraceback(detail: string, traceback: string | null): string {
  if (traceback === null) return detail;
  const head = `${detail}\n`;
  const room = STDERR_TAIL_BYTES - head.length;
  if (traceback.length <= room) return head + traceback;
  const marker = '(truncated)… ';
  return room > marker.length
    ? head + marker + traceback.slice(-(room - marker.length))
    : head + traceback;
}

function truncate(detail: string): string {
  return detail.length > STDERR_TAIL_BYTES
    ? `${detail.slice(0, STDERR_TAIL_BYTES)}… (truncated)`
    : detail;
}
