import { describe, expect, test } from 'vitest';
import { type Document, escapeHtml, renderHtml, renderText } from './layout.ts';

/** Something a user could plausibly name an organization, and that would break out of markup. */
const HOSTILE = '<script>alert("x")</script> & Sons';

describe('escapeHtml', () => {
  test('escapes every character that could end an attribute or open a tag', () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;',
    );
  });

  test('escapes ampersands before the entities it introduces, not after', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });
});

describe('renderText', () => {
  test('spells out a link, since a plain-text reader cannot click a label', () => {
    const document: Document = {
      heading: 'Your report is ready',
      blocks: [{ block: 'action', label: 'View your report', url: 'https://example.test/r/1' }],
    };
    expect(renderText(document)).toContain('View your report: https://example.test/r/1');
  });

  test('leaves user text alone', () => {
    const document: Document = { heading: 'Hi', blocks: [{ block: 'paragraph', text: HOSTILE }] };
    expect(renderText(document)).toContain(HOSTILE);
  });
});

describe('renderHtml', () => {
  test.each([
    ['a heading', { heading: HOSTILE, blocks: [] }],
    ['a paragraph', { heading: 'Hi', blocks: [{ block: 'paragraph', text: HOSTILE }] }],
    ['a fact value', { heading: 'Hi', blocks: [{ block: 'facts', facts: [['Org', HOSTILE]] }] }],
    [
      'a link label',
      { heading: 'Hi', blocks: [{ block: 'links', links: [{ label: HOSTILE, url: '/x' }] }] },
    ],
  ] as ReadonlyArray<[string, Document]>)('escapes user text in %s', (_name, document) => {
    const html = renderHtml(document);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes a url before putting it in an href', () => {
    const document: Document = {
      heading: 'Hi',
      blocks: [{ block: 'action', label: 'Go', url: 'https://example.test/?a=1&b=2' }],
    };
    expect(renderHtml(document)).toContain('href="https://example.test/?a=1&amp;b=2"');
  });
});
