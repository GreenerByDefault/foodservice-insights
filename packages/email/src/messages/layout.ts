/** One shape for every email's copy, rendered to both a plain-text and an HTML body. */

import { APP_NAME, assertNever } from '@gbd/core';
import type { TrustedUrl } from './links.ts';

export type Block =
  | { block: 'paragraph'; text: string }
  /** A primary call to action, styled as a button in the HTML body. Rendered as a bare URL in
   * the text body instead, since a plain-text reader cannot click a label. */
  | { block: 'action'; label: string; url: TrustedUrl }
  /** Secondary links, such as the individual downloads. Same text-body treatment as `action`. */
  | { block: 'links'; links: ReadonlyArray<{ label: string; url: TrustedUrl }> }
  /** Supporting detail, as label/value pairs. */
  | { block: 'facts'; facts: ReadonlyArray<readonly [string, string]> };

export type Document = {
  /** Rendered as the `<h1>` of the HTML body and the `<title>` of the page. */
  heading: string;
  blocks: readonly Block[];
};

/** Neutralizes the characters that let a value break out of a text node or a double- or
 * single-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function blockToText(block: Block): string {
  switch (block.block) {
    case 'paragraph':
      return block.text;
    case 'action':
      return `${block.label}: ${block.url}`;
    case 'links':
      return block.links.map((link) => `${link.label}: ${link.url}`).join('\n');
    case 'facts':
      return block.facts.map(([label, value]) => `${label}: ${value}`).join('\n');
    default:
      return assertNever(block);
  }
}

export function renderText(document: Document): string {
  const parts = document.blocks.map(blockToText);
  return [document.heading, ...parts, `— ${APP_NAME}`].join('\n\n');
}

// Styles are inline because email clients discard `<head>`.
export const BODY_STYLE =
  'margin:0;padding:24px;background:#f5f5f4;' +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;" +
  'font-size:16px;line-height:1.5;color:#1c1917;';
export const CARD_STYLE =
  'max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;';
export const ACTION_STYLE =
  'display:inline-block;padding:12px 20px;background:#166534;color:#ffffff;' +
  'border-radius:6px;text-decoration:none;font-weight:600;';

function blockToHtml(block: Block): string {
  switch (block.block) {
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'action':
      return `<p><a href="${escapeHtml(block.url)}" style="${ACTION_STYLE}">${escapeHtml(block.label)}</a></p>`;
    case 'links':
      return `<ul style="margin:0;padding:0 0 0 20px;">${block.links
        .map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></li>`)
        .join('')}</ul>`;
    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0"><tbody>${block.facts
        .map(
          ([label, value]) =>
            `<tr><th align="left" style="padding:0 16px 4px 0;font-weight:600;">${escapeHtml(label)}</th>` +
            `<td style="padding:0 0 4px 0;">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</tbody></table>`;
    default:
      return assertNever(block);
  }
}

export function renderHtml(document: Document): string {
  const blocks = document.blocks.map(blockToHtml);

  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.heading)}</title></head>`,
    `<body style="${BODY_STYLE}">`,
    `<div style="${CARD_STYLE}">`,
    `<h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(document.heading)}</h1>`,
    ...blocks,
    `<p style="margin:24px 0 0;color:#57534e;font-size:14px;">— ${escapeHtml(APP_NAME)}</p>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
