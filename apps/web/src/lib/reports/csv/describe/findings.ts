/** A whole `Findings` into the `RejectedUploadRecord` a customer sees: the summary, the reason,
 * and the detail — the assembly that budgets row problems against the date-order problem.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_PROBLEMS_REPORTED } from '../../limits.ts';
import type { RejectedUploadRecord } from '../../rejection.ts';
import type { Findings } from '../findings.ts';
import { describeDateOrderFinding } from './date-order.ts';
import { renderProblemsAsDetail } from './problems.ts';
import { toProblem } from './rows.ts';
import { groupDigits, plural } from './text.ts';

export function describeFindings(findings: Findings): RejectedUploadRecord {
  const rowProblems = findings.rowGroups.map((group) => toProblem(group, findings.rowsRead));
  const dateOrderProblem = findings.dateOrder && describeDateOrderFinding(findings.dateOrder);

  // The date-order problem always gets a slot: it's a fatal, file-wide failure, so row problems
  // must not crowd it out.
  const shownDateOrderProblem = dateOrderProblem;
  const rowProblemSlots = MAX_PROBLEMS_REPORTED - (shownDateOrderProblem ? 1 : 0);
  const shownRowProblems = rowProblems.slice(0, rowProblemSlots);

  const totalKinds = rowProblems.length + (dateOrderProblem ? 1 : 0);
  const shownKinds = shownRowProblems.length + (shownDateOrderProblem ? 1 : 0);
  const hidden = totalKinds - shownKinds;

  const injection = findings.rowGroups.some((group) => group.finding.kind === 'formula');
  const reason = injection ? 'csv_injection' : 'bad_rows';

  const scale = headline(findings.failingRowCount, findings.rowsRead);
  const truncationNote = hidden > 0 ? ` Showing ${shownKinds} of ${totalKinds} things to fix.` : '';

  const detailParts = [
    ...(shownDateOrderProblem ? [shownDateOrderProblem] : []),
    ...(shownRowProblems.length > 0 ? [renderProblemsAsDetail(shownRowProblems)] : []),
    ...(hidden > 0 ? [`and ${hidden} more`] : []),
  ];

  return {
    reason,
    summary: `${scale}${truncationNote}`,
    ...(shownRowProblems.length > 0 && { rowProblems: shownRowProblems }),
    ...(shownDateOrderProblem && { dateOrderProblem: shownDateOrderProblem }),
    rejectionDetail: detailParts.join('; '),
  };
}

function headline(failingRowCount: number, rowsRead: number): string {
  const found = groupDigits(failingRowCount);
  return `We found problems in ${found} of your ${groupDigits(rowsRead)} ${plural(rowsRead, 'row')}.`;
}
