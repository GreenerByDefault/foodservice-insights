import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { rejectionWith } from '$lib/reports/csv/testing';
import type { UploadRejection } from '$lib/reports/rejection';
import RejectionView from './rejection-view.svelte';

describe('RejectionView', () => {
  describe('heading', () => {
    test('the summary is the heading and takes focus', async () => {
      const rejection = rejectionWith(1);
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      const heading = screen.getByRole('heading', { name: rejection.summary });
      await expect.element(heading).toBeInTheDocument();
      await expect.element(heading).toHaveFocus();
    });
  });

  describe('row problems', () => {
    test('a date-order problem renders above the first list item', async () => {
      const rejection = rejectionWith(1);
      const { dateOrderProblem } = rejection;
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      await expect.element(screen.getByText(dateOrderProblem)).toBeInTheDocument();

      // Both render; the source order in the container is what puts the date-order block first.
      const html = screen.container.innerHTML;
      expect(html.indexOf(dateOrderProblem)).toBeLessThan(html.indexOf('<ol'));
    });

    test('every problem renders its rows, rule, advice and examples', async () => {
      const rejection = rejectionWith(1);
      const [problem] = rejection.rowProblems;
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      if (!problem.advice) throw new Error('expected the fixture problem to carry advice');

      await expect
        .element(screen.getByText('all 4,500 rows', { exact: false }))
        .toBeInTheDocument();
      await expect.element(screen.getByText(`${problem.rule}.`)).toBeInTheDocument();
      await expect.element(screen.getByText(problem.advice)).toBeInTheDocument();
      for (const example of problem.examples) {
        await expect.element(screen.getByText(example, { exact: false })).toBeInTheDocument();
      }
    });

    test('a problem that fails on every row gets the muted whole-file background', async () => {
      const rejection = rejectionWith(2);
      const [everyRowProblem, oneRowProblem] = rejection.rowProblems;
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      const items = screen.getByRole('listitem').elements();
      expect(items[0]?.className).toContain('bg-muted/50');
      expect(items[1]?.className).not.toContain('bg-muted/50');

      // Sanity check the fixture still models what this test is about.
      expect(everyRowProblem.rows.everyRow).toBe(true);
      expect(oneRowProblem?.rows.everyRow).toBe(false);
    });

    test('an example is not double-quoted', async () => {
      const rejection = rejectionWith(1);
      const [problem] = rejection.rowProblems;
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

    test('a problem with no advice and no examples renders only its rows and rule', async () => {
      const rejection: UploadRejection = {
        summary: 'We found problems in your rows.',
        rowProblems: [
          {
            rule: 'The product is a placeholder rather than a product',
            rows: { ranges: [{ start: 2, end: 2 }], total: 1, everyRow: false },
            examples: [],
          },
        ],
      };
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      await expect
        .element(screen.getByText('The product is a placeholder rather than a product.'))
        .toBeInTheDocument();
      // No advice paragraph and no examples row for this problem — nothing else to assert it
      // against, so the item's whole text content is the check.
      expect(screen.getByRole('listitem').elements()[0]?.textContent?.trim()).toBe(
        'row 2 The product is a placeholder rather than a product.',
      );
    });
  });

  describe('summary-only rejections', () => {
    test('a rejection with only a summary (an unreadable file, or a rate limit) renders no list', async () => {
      const rejection: UploadRejection = { summary: 'That file has no rows in it.' };
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      await expect.element(screen.getByText(rejection.summary)).toBeInTheDocument();
      expect(screen.getByRole('listitem').elements()).toHaveLength(0);
    });
  });

  describe('back button', () => {
    test('a bare summary gets only the bottom button, not one next to the heading too', async () => {
      const rejection: UploadRejection = { summary: 'Your file needs a column for weight.' };
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      expect(screen.getByRole('button', { name: 'Back to the form' }).elements()).toHaveLength(1);
    });

    test('a rejection with row problems keeps the button next to the heading too', async () => {
      const rejection = rejectionWith(1);
      const screen = await render(RejectionView, { rejection, onBack: () => {} });

      expect(screen.getByRole('button', { name: 'Back to the form' }).elements()).toHaveLength(2);
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
});
