/** What a child's ending *means* — pure, so the ~20-case matrix below runs in milliseconds and
 * needs no fixture beyond the values it switches on. Everything that produces those values (a
 * process exit, a file read) lives in [`attempt-lifecycle.ts`](./attempt-lifecycle.ts).
 */

import type { AnalysisFailureReason } from '@gbd/db';
import type { ChildOutcome } from './child.ts';
import { type ChildFailure, type ChildResult, ContractError } from './contract/messages.ts';

/** Why the parent ended the child, decided by `supervise()` (landing with the loop that reads a
 * `Clock`). Carried here as data rather than acted on here, because whether a kill turns into a
 * verdict at all depends on how the child itself ended — see the fourth row below.
 */
export type Kill =
  | { reason: 'canceled' }
  | { reason: 'hung' }
  | { reason: 'hard-timeout' }
  | { reason: 'shutting-down' }
  | { reason: 'fenced' }
  | { reason: 'lost' }
  | { reason: 'contract-violation'; detail: string };

/** Every I/O the decision needs, already performed. `result`/`failure` are set only when the
 * child exited with the matching code and the document parsed; `readError` is set when a read we
 * needed threw. `missingResultFiles` is always present, and empty unless the child exited 0 with
 * a parseable result that named a file it never wrote.
 */
export type ChildEnding = {
  outcome: ChildOutcome;
  kill?: Kill;
  result?: ChildResult;
  failure?: ChildFailure;
  readError?: unknown;
  missingResultFiles: readonly string[];
};

export type Verdict =
  | { kind: 'succeeded'; result: ChildResult }
  | { kind: 'failed'; reason: AnalysisFailureReason; detail: string }
  | { kind: 'canceled' }
  /** Fenced or reaped: kill the child, write nothing, leave the standing verdict alone. */
  | { kind: 'unowned' };

/** First match wins. Letting the child's own verdict outrank a kill is safe because it requires
 * `outcome.kind === 'exited'`: a child that wrote `result.json` and then hung dies by signal,
 * never matches, and falls through to `hung` below. `canceled`, `fenced`, and `lost` still
 * outrank it: the first is the user's explicit intent, the other two are attempts we may no
 * longer write at all.
 */
export function classifyVerdict(ending: ChildEnding): Verdict {
  const { outcome, kill, result, failure, readError, missingResultFiles } = ending;

  if (kill?.reason === 'fenced' || kill?.reason === 'lost') return { kind: 'unowned' };
  if (kill?.reason === 'canceled') return { kind: 'canceled' };
  if (outcome.kind === 'spawn-failed') {
    return {
      kind: 'failed',
      reason: 'infrastructure',
      detail: `could not start the child: ${describe(outcome.error)}`,
    };
  }

  if (
    outcome.kind === 'exited' &&
    outcome.exitCode === 0 &&
    result !== undefined &&
    missingResultFiles.length === 0
  ) {
    return { kind: 'succeeded', result };
  }
  if (outcome.kind === 'exited' && outcome.exitCode === 1 && failure !== undefined) {
    return { kind: 'failed', reason: failure.reason, detail: failure.detail };
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

  if (readError !== undefined) {
    return readError instanceof ContractError
      ? { kind: 'failed', reason: 'contract_violation', detail: readError.message }
      : { kind: 'failed', reason: 'infrastructure', detail: describe(readError) };
  }

  if (outcome.kind === 'exited' && outcome.exitCode === 0) {
    const detail =
      missingResultFiles.length > 0
        ? `result.json declared file(s) never written: ${missingResultFiles.join(', ')}`
        : 'exited 0 without writing result.json';
    return { kind: 'failed', reason: 'contract_violation', detail };
  }
  if (outcome.kind === 'exited' && outcome.exitCode === 1) {
    return {
      kind: 'failed',
      reason: 'contract_violation',
      detail: 'exited 1 without writing failure.json',
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

function crashDetail(head: string, stderrTail: string): string {
  return stderrTail.length > 0 ? `${head}\n${stderrTail}` : head;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
