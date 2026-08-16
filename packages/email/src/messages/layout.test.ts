import { describe, expect, test } from 'vitest';
import {
  ACTION_STYLE,
  BODY_STYLE,
  CARD_STYLE,
  type Document,
  escapeHtml,
  renderHtml,
  renderText,
} from './layout.ts';
import type { TrustedUrl } from './links.ts';

/** Something a user could plausibly name an organization, and that would break out of markup. */
const HOSTILE = '<script>alert("x")</script> & Sons';
const HOSTILE_ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons';

/** These tests exercise rendering, not `links.ts`'s url-building, so they stand in for it with a
 * bare cast rather than routing every fixture through a real builder. */
const asUrl = (value: string): TrustedUrl => value as TrustedUrl;

function expectedHtml(heading: string, blockHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>`,
    `<body style="${BODY_STYLE}">`,
    `<div style="${CARD_STYLE}">`,
    `<h1 style="margin:0 0 16px;font-size:20px;">${heading}</h1>`,
    ...(blockHtml === '' ? [] : [blockHtml]),
    '<p style="margin:24px 0 0;color:#57534e;font-size:14px;">— Foodservice Insights</p>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

describe('escapeHtml', () => {
  test('escapes every character that could end an attribute or open a tag', () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;',
    );
  });

  test('escapes ampersands before the entities it introduces, not after', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });

  test('leaves text with nothing to escape unchanged', () => {
    expect(escapeHtml('Plain text, no markup here.')).toBe('Plain text, no markup here.');
  });
});

describe('renderText', () => {
  test('joins the heading, each block, and the signature with blank lines', () => {
    const document: Document = {
      heading: 'Your report is ready',
      blocks: [
        { block: 'paragraph', text: 'Here is what changed.' },
        { block: 'action', label: 'View your report', url: asUrl('https://example.test/r/1') },
      ],
    };
    expect(renderText(document)).toBe(
      [
        'Your report is ready',
        'Here is what changed.',
        'View your report: https://example.test/r/1',
        '— Foodservice Insights',
      ].join('\n\n'),
    );
  });

  test('spells out a link, since a plain-text reader cannot click a label', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        { block: 'action', label: 'View your report', url: asUrl('https://example.test/r/1') },
      ],
    };
    expect(renderText(document)).toBe(
      ['Hi', 'View your report: https://example.test/r/1', '— Foodservice Insights'].join('\n\n'),
    );
  });

  test('joins multiple links with newlines, one "label: url" per line', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        {
          block: 'links',
          links: [
            { label: 'Download A', url: asUrl('https://example.test/a') },
            { label: 'Download B', url: asUrl('https://example.test/b') },
          ],
        },
      ],
    };
    expect(renderText(document)).toBe(
      [
        'Hi',
        'Download A: https://example.test/a\nDownload B: https://example.test/b',
        '— Foodservice Insights',
      ].join('\n\n'),
    );
  });

  test('joins facts with newlines, one "label: value" per line', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        {
          block: 'facts',
          facts: [
            ['Organization', 'Acme'],
            ['Report', 'Q1'],
          ],
        },
      ],
    };
    expect(renderText(document)).toBe(
      ['Hi', 'Organization: Acme\nReport: Q1', '— Foodservice Insights'].join('\n\n'),
    );
  });

  test('renders just the heading and signature when there are no blocks', () => {
    const document: Document = { heading: 'Hi', blocks: [] };
    expect(renderText(document)).toBe(['Hi', '— Foodservice Insights'].join('\n\n'));
  });

  test('leaves user text alone, since a plain-text body has no markup to escape', () => {
    const document: Document = { heading: 'Hi', blocks: [{ block: 'paragraph', text: HOSTILE }] };
    expect(renderText(document)).toBe(['Hi', HOSTILE, '— Foodservice Insights'].join('\n\n'));
  });
});

describe('renderHtml', () => {
  test('renders a document with no blocks', () => {
    const document: Document = { heading: 'Hi', blocks: [] };
    expect(renderHtml(document)).toBe(expectedHtml('Hi', ''));
  });

  test('renders a paragraph as a <p>', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [{ block: 'paragraph', text: 'Here is what changed.' }],
    };
    expect(renderHtml(document)).toBe(expectedHtml('Hi', '<p>Here is what changed.</p>'));
  });

  test('renders an action as a styled link, since email clients discard <head>', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        { block: 'action', label: 'View your report', url: asUrl('https://example.test/r/1') },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        `<p><a href="https://example.test/r/1" style="${ACTION_STYLE}">View your report</a></p>`,
      ),
    );
  });

  test('renders links as a bulleted list', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        {
          block: 'links',
          links: [
            { label: 'Download A', url: asUrl('https://example.test/a') },
            { label: 'Download B', url: asUrl('https://example.test/b') },
          ],
        },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        '<ul style="margin:0;padding:0 0 0 20px;">' +
          '<li><a href="https://example.test/a">Download A</a></li>' +
          '<li><a href="https://example.test/b">Download B</a></li>' +
          '</ul>',
      ),
    );
  });

  test('renders facts as a label/value table', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        {
          block: 'facts',
          facts: [
            ['Organization', 'Acme'],
            ['Report', 'Q1'],
          ],
        },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        '<table role="presentation" cellpadding="0" cellspacing="0"><tbody>' +
          '<tr><th align="left" style="padding:0 16px 4px 0;font-weight:600;">Organization</th>' +
          '<td style="padding:0 0 4px 0;">Acme</td></tr>' +
          '<tr><th align="left" style="padding:0 16px 4px 0;font-weight:600;">Report</th>' +
          '<td style="padding:0 0 4px 0;">Q1</td></tr>' +
          '</tbody></table>',
      ),
    );
  });

  test('renders multiple blocks in order, one after another', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        { block: 'paragraph', text: 'Here is what changed.' },
        { block: 'action', label: 'View your report', url: asUrl('https://example.test/r/1') },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        '<p>Here is what changed.</p>\n' +
          `<p><a href="https://example.test/r/1" style="${ACTION_STYLE}">View your report</a></p>`,
      ),
    );
  });

  test.each([
    ['a heading', { heading: HOSTILE, blocks: [] }, () => expectedHtml(HOSTILE_ESCAPED, '')],
    [
      'a paragraph',
      { heading: 'Hi', blocks: [{ block: 'paragraph', text: HOSTILE }] },
      () => expectedHtml('Hi', `<p>${HOSTILE_ESCAPED}</p>`),
    ],
    [
      'a fact label and value',
      { heading: 'Hi', blocks: [{ block: 'facts', facts: [[HOSTILE, HOSTILE]] }] },
      () =>
        expectedHtml(
          'Hi',
          '<table role="presentation" cellpadding="0" cellspacing="0"><tbody>' +
            `<tr><th align="left" style="padding:0 16px 4px 0;font-weight:600;">${HOSTILE_ESCAPED}</th>` +
            `<td style="padding:0 0 4px 0;">${HOSTILE_ESCAPED}</td></tr>` +
            '</tbody></table>',
        ),
    ],
    [
      'a link label',
      {
        heading: 'Hi',
        blocks: [{ block: 'links', links: [{ label: HOSTILE, url: asUrl('/x') }] }],
      },
      () =>
        expectedHtml(
          'Hi',
          `<ul style="margin:0;padding:0 0 0 20px;"><li><a href="/x">${HOSTILE_ESCAPED}</a></li></ul>`,
        ),
    ],
  ] as ReadonlyArray<[string, Document, () => string]>)(
    'escapes user text in %s',
    (_name, document, expected) => {
      expect(renderHtml(document)).toBe(expected());
    },
  );

  test('escapes a url before putting it in an href', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [{ block: 'action', label: 'Go', url: asUrl('https://example.test/?a=1&b=2') }],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        `<p><a href="https://example.test/?a=1&amp;b=2" style="${ACTION_STYLE}">Go</a></p>`,
      ),
    );
  });

  /** The attack a query-string `&` can't exercise: a `"` closes the `href` attribute early,
   * so anything after it — like an `onmouseover` — would parse as a new attribute instead of
   * URL text if `escapeHtml` didn't neutralize it. */
  test('escapes a quote in a url so it cannot close the href attribute early', () => {
    const breakout = asUrl('https://example.test/"><script>alert(1)</script>');
    const breakoutEscaped = 'https://example.test/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
    const document: Document = {
      heading: 'Hi',
      blocks: [
        { block: 'action', label: 'Go', url: breakout },
        { block: 'links', links: [{ label: 'Go', url: breakout }] },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        `<p><a href="${breakoutEscaped}" style="${ACTION_STYLE}">Go</a></p>\n` +
          `<ul style="margin:0;padding:0 0 0 20px;"><li><a href="${breakoutEscaped}">Go</a></li></ul>`,
      ),
    );
  });
});
