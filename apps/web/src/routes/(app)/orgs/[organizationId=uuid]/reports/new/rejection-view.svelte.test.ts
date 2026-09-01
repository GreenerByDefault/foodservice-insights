import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Problem } from '$lib/reports/csv/describe';
import { rejectionWith } from '$lib/reports/csv/testing';
import type { UploadRejection } from '$lib/reports/rejection';
import RejectionView from './rejection-view.svelte';

/** `rejectionWith(1)`'s one row problem, and its date-order problem — both are `Problem[]` and
 * `string | undefined` on the type, but the fixture always sets them. */
function fixtureParts(rejection: UploadRejection): { problem: Problem; dateOrderProblem: string } {
  const [problem] = rejection.rowProblems ?? [];
  if (!problem) throw new Error('expected rejectionWith(1) to include a row problem');
  if (!rejection.dateOrderProblem)
    throw new Error('expected rejectionWith(1) to include a date-order problem');
  return { problem, dateOrderProblem: rejection.dateOrderProblem };
}

describe('RejectionView', () => {
  test('the summary is the heading and takes focus', async () => {
    const rejection = rejectionWith(1);
    const screen = await render(RejectionView, { rejection, onBack: () => {} });

    const heading = screen.getByRole('heading', { name: rejection.summary });
    await expect.element(heading).toBeInTheDocument();
    await expect.element(heading).toHaveFocus();
  });

  test('a date-order problem renders above the first list item', async () => {
    const rejection = rejectionWith(1);
    const { dateOrderProblem } = fixtureParts(rejection);
    const screen = await render(RejectionView, { rejection, onBack: () => {} });

    await expect.element(screen.getByText(dateOrderProblem)).toBeInTheDocument();

    // Both render; the source order in the container is what puts the date-order block first.
    const html = screen.container.innerHTML;
    expect(html.indexOf(dateOrderProblem)).toBeLessThan(html.indexOf('<ol'));
  });

  test('every problem renders its rows, rule, advice and examples', async () => {
    const rejection = rejectionWith(1);
    const { problem } = fixtureParts(rejection);
    const screen = await render(RejectionView, { rejection, onBack: () => {} });

    if (!problem.advice) throw new Error('expected the fixture problem to carry advice');

    await expect.element(screen.getByText('all 4,500 rows', { exact: false })).toBeInTheDocument();
    await expect.element(screen.getByText(`${problem.rule}.`)).toBeInTheDocument();
    await expect.element(screen.getByText(problem.advice)).toBeInTheDocument();
    for (const example of problem.examples) {
      await expect.element(screen.getByText(example, { exact: false })).toBeInTheDocument();
    }
  });

  test('an example is not double-quoted', async () => {
    const rejection = rejectionWith(1);
    const { problem } = fixtureParts(rejection);
    const [example] = problem.examples;
    if (!example) throw new Error('expected the fixture problem to carry an example');
    const screen = await render(RejectionView, { rejection, onBack: () => {} });

    await expect.element(screen.getByText(example)).toBeInTheDocument();
    await expect.element(screen.getByText(`"${example}"`)).not.toBeInTheDocument();
  });

  test('a 20-problem rejection renders 20 items', async () => {
    const rejection = rejectionWith(20);
    const screen = await render(RejectionView, { rejection, onBack: () => {} });

    await expect.element(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByRole('listitem').elements()).toHaveLength(20);
  });

  test('a Shape A rejection (summary only) renders no list', async () => {
    const rejection: UploadRejection = { summary: 'That file has no rows in it.' };
    const screen = await render(RejectionView, { rejection, onBack: () => {} });

    await expect.element(screen.getByText(rejection.summary)).toBeInTheDocument();
    expect(screen.getByRole('listitem').elements()).toHaveLength(0);
  });

  test('Back to the form calls onBack', async () => {
    let backCount = 0;
    const rejection = rejectionWith(1);
    const screen = await render(RejectionView, {
      rejection,
      onBack: () => {
        backCount += 1;
      },
    });

    await screen.getByRole('button', { name: 'Back to the form' }).first().click();
    expect(backCount).toBe(1);
  });
});
