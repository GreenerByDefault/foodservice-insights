/** An axe-core scan of the page as it stands, failing on any violation axe can detect.
 *
 * axe catches what a machine can see — contrast, names, roles, ARIA misuse, landmarks. Keyboard
 * flow and focus are beyond it, and still need their own specs. A violation on our own markup is
 * fixed, not exempted. What can't be fixed yet goes in one of the two tables
 * below, which differ in what they promise:
 *
 * 1. `FALSE_POSITIVES` — axe is wrong about our page. Permanent; each says why it isn't a barrier.
 * 2. `UNFIXED` — a real barrier we haven't fixed yet. Debt: each names a screen it shows on, and
 *    the scan of that screen fails once the violation is gone, until its entry is deleted. So the
 *    table only shrinks, and each entry shows up as an annotation on every test it suppresses.
 *
 * An exemption is a rule plus a selector, never a rule alone: the same rule anywhere else still
 * fails.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page, test } from '@playwright/test';
import type axe from 'axe-core';

type Exemption = {
  /** An axe rule id, as a failure names it. */
  rule: string;
  /** Matches the flagged element or an ancestor of it. Tested while the page is in the state
   * scanned, so a state like `:hover` works. */
  within: string;
  why: string;
};

const FALSE_POSITIVES: readonly Exemption[] = [
  {
    rule: 'region',
    within: '[data-bits-floating-content-wrapper]',
    why:
      'bits-ui portals every menu and popover to <body>, outside any landmark. It is reached ' +
      'from the trigger that opened it, not by landmark: the reason axe already exempts a dialog.',
  },
];

const UNFIXED: readonly (Exemption & {
  /** An image it is known to occur in, as a path under `e2e/__screenshots__` — one width, since
   * a state like hover only exists at one. */
  seenOn: string;
})[] = [
  {
    rule: 'color-contrast',
    within: '[data-slot="alert-dialog-action"]',
    why:
      "ConfirmAction's destructive button is red on its own pink tint, 4.0:1 against the 4.5:1 " +
      'text needs — the `destructive` variant in `ui/button/button.svelte`.',
    seenOn: 'account/account-delete-dialog.png',
  },
  {
    rule: 'color-contrast',
    within: 'a:hover',
    why:
      "A hovered row's `bg-accent` takes `text-muted-foreground` to 4.34:1, short of 4.5:1. " +
      'Both tokens are in `layout.css`.',
    seenOn: 'reports-list/list.png',
  },
];

/** The minified build: `axe.source` is the unminified one, twice the size, and sending and parsing
 * it was most of what a scan cost. */
const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

type Violation = {
  rule: string;
  help: string;
  helpUrl: string;
  nodes: { target: string; html: string; failureSummary: string }[];
};

type ScanResult = {
  violations: Violation[];
  /** Index into `UNFIXED`, for each one this scan matched. */
  unfixedMatched: number[];
};

/** Fail if axe finds a violation on `page` that no exemption covers.
 *
 * `screen` is the image `expectScreenshots` just captured, which is what lets an `UNFIXED` entry
 * notice it has been fixed. */
export async function expectNoA11yViolations(page: Page, screen?: string): Promise<void> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE);

  const { violations, unfixedMatched } = await page.evaluate(scan, {
    falsePositives: FALSE_POSITIVES,
    unfixed: UNFIXED,
  });

  const matched = UNFIXED.filter((_, index) => unfixedMatched.includes(index));
  const { annotations } = test.info();
  for (const { rule, why } of matched) {
    const description = `${rule}: ${why}`;
    // A screen is scanned at every width, and most violations show at all of them.
    if (annotations.some((annotation) => annotation.description === description)) continue;
    annotations.push({ type: 'unfixed a11y violation', description });
  }

  expect(violations, 'axe found accessibility violations; see e2e/lib/a11y.ts').toEqual([]);

  const stale = UNFIXED.filter((entry) => entry.seenOn === screen && !matched.includes(entry));
  expect(
    stale,
    `${screen} no longer has these violations. Delete their UNFIXED entries in e2e/lib/a11y.ts.`,
  ).toEqual([]);
}

/** Runs in the page, so it can test each flagged element against the exemptions' selectors in the
 * state that was scanned. Self-contained: Playwright serializes it by source. */
async function scan({
  falsePositives,
  unfixed,
}: {
  falsePositives: readonly Exemption[];
  unfixed: readonly Exemption[];
}): Promise<ScanResult> {
  // A spec that pauses `page.clock` (to freeze a countdown) also pauses every `setTimeout`, and
  // axe schedules its work on them, so the scan would hang until the test timed out. Playwright
  // keeps the real timers on `__pwClock` for its own injected scripts; lend them to axe.
  const real = (window as { __pwClock?: { builtins: Pick<Window, 'setTimeout' | 'clearTimeout'> } })
    .__pwClock?.builtins;
  const { setTimeout, clearTimeout } = window;
  if (real) Object.assign(window, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout });

  let results: axe.AxeResults;
  try {
    results = await (window as unknown as { axe: typeof axe }).axe.run(document, {
      elementRef: true,
      // Skips building the passes and incompletes, which nothing here reads.
      resultTypes: ['violations'],
    });
  } finally {
    Object.assign(window, { setTimeout, clearTimeout });
  }

  const covers = (rule: string, element: Element | undefined) => (exemption: Exemption) =>
    exemption.rule === rule && element?.closest(exemption.within) != null;

  const unfixedMatched: number[] = [];
  const violations = results.violations
    .map(({ id, help, helpUrl, nodes }) => ({
      rule: id,
      help,
      helpUrl,
      nodes: nodes
        .filter(({ element }) => {
          if (falsePositives.some(covers(id, element))) return false;
          const index = unfixed.findIndex(covers(id, element));
          if (index === -1) return true;
          unfixedMatched.push(index);
          return false;
        })
        .map(({ target, html, failureSummary }) => ({
          target: target.join(' '),
          html,
          failureSummary: failureSummary ?? '',
        })),
    }))
    .filter(({ nodes }) => nodes.length > 0);

  return { violations, unfixedMatched };
}
