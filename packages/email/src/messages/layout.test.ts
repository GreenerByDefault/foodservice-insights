import { describe, expect, test } from 'vitest';
import {
  ACTION_STYLE,
  BODY_STYLE,
  CANVAS_STYLE,
  CARD_STYLE,
  CONTENT_STYLE,
  type Document,
  escapeHtml,
  FACT_LABEL_STYLE,
  FACT_VALUE_STYLE,
  FOOTER_HTML,
  FOOTER_STYLE,
  HEADING_STYLE,
  LINK_STYLE,
  MASTHEAD_STYLE,
  PARAGRAPH_STYLE,
  PREHEADER_STYLE,
  renderHtml,
  renderText,
  WORDMARK,
} from './layout.ts';
import type { TrustedUrl } from './links.ts';

/** Something a user could plausibly name an organization, and that would break out of markup. */
const HOSTILE = '<script>alert("x")</script> & Sons';
const HOSTILE_ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons';

/** These tests exercise rendering, not `links.ts`'s url-building, so they stand in for it with a
 * bare cast rather than routing every fixture through a real builder. */
function asUrl(value: string): TrustedUrl {
  return value as TrustedUrl;
}

/** The page around a document's blocks. `preheader` is the hidden inbox preview, which the renderer
 * takes from the first paragraph. */
function expectedHtml(heading: string, blockHtml: string, preheader?: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
      `<title>${heading}</title></head>`,
    `<body style="${BODY_STYLE}">`,
    ...(preheader === undefined ? [] : [`<div style="${PREHEADER_STYLE}">${preheader}</div>`]),
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#FDF9F1"><tr><td align="center" style="${CANVAS_STYLE}">`,
    '<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" width="560"><tr><td><![endif]-->',
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="${CARD_STYLE}">`,
    `<tr><td bgcolor="#016939" style="${MASTHEAD_STYLE}">${WORDMARK}</td></tr>`,
    '<tr><td bgcolor="#D9E027" height="4" style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>',
    `<tr><td align="left" style="${CONTENT_STYLE}">`,
    `<h1 style="${HEADING_STYLE}">${heading}</h1>`,
    ...(blockHtml === '' ? [] : [blockHtml]),
    '</td></tr>',
    '</table>',
    `<p style="${FOOTER_STYLE}">${FOOTER_HTML}</p>`,
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}

function paragraphHtml(text: string): string {
  return `<p style="${PARAGRAPH_STYLE}">${text}</p>`;
}

function actionHtml(href: string, label: string): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">' +
    `<tr><td bgcolor="#016939" style="border-radius:999px;"><a href="${href}" style="${ACTION_STYLE}">${label}</a></td></tr>` +
    '</table>'
  );
}

function linksHtml(links: ReadonlyArray<readonly [href: string, label: string]>): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px;border-top:1px solid #E6DDCC;">' +
    links
      .map(
        ([href, label]) =>
          '<tr><td style="padding:12px 0;border-bottom:1px solid #E6DDCC;">' +
          `<a href="${href}" style="${LINK_STYLE}">${label}</a></td></tr>`,
      )
      .join('') +
    '</table>'
  );
}

function factsHtml(facts: ReadonlyArray<readonly [label: string, value: string]>): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#F4EEE2" style="margin:8px 0 16px;border-radius:12px;">' +
    '<tr><td style="padding:16px 20px;"><table role="presentation" cellpadding="0" cellspacing="0">' +
    facts
      .map(
        ([label, value]) =>
          `<tr><th align="left" valign="top" style="${FACT_LABEL_STYLE}">${label}</th>` +
          `<td style="${FACT_VALUE_STYLE}">${value}</td></tr>`,
      )
      .join('') +
    '</table></td></tr></table>'
  );
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
        '— PLATE (Greener by Default)',
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
      ['Hi', 'View your report: https://example.test/r/1', '— PLATE (Greener by Default)'].join(
        '\n\n',
      ),
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
        '— PLATE (Greener by Default)',
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
      ['Hi', 'Organization: Acme\nReport: Q1', '— PLATE (Greener by Default)'].join('\n\n'),
    );
  });

  test('renders just the heading and signature when there are no blocks', () => {
    const document: Document = { heading: 'Hi', blocks: [] };
    expect(renderText(document)).toBe(['Hi', '— PLATE (Greener by Default)'].join('\n\n'));
  });

  test('leaves user text alone, since a plain-text body has no markup to escape', () => {
    const document: Document = { heading: 'Hi', blocks: [{ block: 'paragraph', text: HOSTILE }] };
    expect(renderText(document)).toBe(['Hi', HOSTILE, '— PLATE (Greener by Default)'].join('\n\n'));
  });
});

describe('renderHtml', () => {
  test('renders a document with no blocks', () => {
    const document: Document = { heading: 'Hi', blocks: [] };
    expect(renderHtml(document)).toBe(expectedHtml('Hi', ''));
  });

  test('renders a paragraph as a <p>, and previews it in the inbox', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [{ block: 'paragraph', text: 'Here is what changed.' }],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml('Hi', paragraphHtml('Here is what changed.'), 'Here is what changed.'),
    );
  });

  test('previews only the first paragraph, wherever it falls', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        { block: 'facts', facts: [['Organization', 'Acme']] },
        { block: 'paragraph', text: 'First.' },
        { block: 'paragraph', text: 'Second.' },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml(
        'Hi',
        [
          factsHtml([['Organization', 'Acme']]),
          paragraphHtml('First.'),
          paragraphHtml('Second.'),
        ].join('\n'),
        'First.',
      ),
    );
  });

  test('renders an action as a button, since email clients discard <head>', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [
        { block: 'action', label: 'View your report', url: asUrl('https://example.test/r/1') },
      ],
    };
    expect(renderHtml(document)).toBe(
      expectedHtml('Hi', actionHtml('https://example.test/r/1', 'View your report')),
    );
  });

  test('renders links as rows', () => {
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
        linksHtml([
          ['https://example.test/a', 'Download A'],
          ['https://example.test/b', 'Download B'],
        ]),
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
        factsHtml([
          ['Organization', 'Acme'],
          ['Report', 'Q1'],
        ]),
      ),
    );
  });

  test.each([
    ['a heading', { heading: HOSTILE, blocks: [] }, () => expectedHtml(HOSTILE_ESCAPED, '')],
    [
      'a paragraph and its preview',
      { heading: 'Hi', blocks: [{ block: 'paragraph', text: HOSTILE }] },
      () => expectedHtml('Hi', paragraphHtml(HOSTILE_ESCAPED), HOSTILE_ESCAPED),
    ],
    [
      'a fact label and value',
      { heading: 'Hi', blocks: [{ block: 'facts', facts: [[HOSTILE, HOSTILE]] }] },
      () => expectedHtml('Hi', factsHtml([[HOSTILE_ESCAPED, HOSTILE_ESCAPED]])),
    ],
    [
      'an action label',
      { heading: 'Hi', blocks: [{ block: 'action', label: HOSTILE, url: asUrl('/x') }] },
      () => expectedHtml('Hi', actionHtml('/x', HOSTILE_ESCAPED)),
    ],
    [
      'a link label',
      {
        heading: 'Hi',
        blocks: [{ block: 'links', links: [{ label: HOSTILE, url: asUrl('/x') }] }],
      },
      () => expectedHtml('Hi', linksHtml([['/x', HOSTILE_ESCAPED]])),
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
      expectedHtml('Hi', actionHtml('https://example.test/?a=1&amp;b=2', 'Go')),
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
        `${actionHtml(breakoutEscaped, 'Go')}\n${linksHtml([[breakoutEscaped, 'Go']])}`,
      ),
    );
  });
});
