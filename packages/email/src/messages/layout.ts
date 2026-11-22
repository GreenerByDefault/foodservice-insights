/** One shape for every email's copy, rendered to both a plain-text and an HTML body. */

import { APP_FULL_NAME, APP_NAME, assertNever } from '@gbd/core';
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
  return [document.heading, ...parts, `— ${APP_FULL_NAME}`].join('\n\n');
}

// Styles are inline because email clients discard `<head>`, and Gmail drops `<body>`'s style too,
// so the page color and font live on a wrapper table. Layout is tables because Outlook for
// Windows renders with Word, which ignores `max-width` and most of the box model on a `<div>`.
//
// The colors copy GBD's palette from `apps/web/src/routes/layout.css`, which states them in
// oklch; `supabase-dev/supabase/templates/` copies these same values by hand. Chartreuse is
// decoration only: it fails contrast as text on cream or white.
//
// An image must come from the web app's `static/`: anything served through `handle` answers
// `Cross-Origin-Resource-Policy: same-origin`, which blocks webmail clients that load it directly.
const GREEN = '#016939';
const CREAM = '#FDF9F1';
const BROWN = '#403428';
const SAND = '#F4EEE2';
const MUTED = '#6E6052';
const BORDER = '#E6DDCC';
const CHARTREUSE = '#D9E027';

const GBD_URL = 'https://www.greenerbydefault.com';

/** Poppins when the reader has it installed; clients cannot load webfonts reliably. */
const FONT_STACK = "Poppins,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const BODY_STYLE = `margin:0;padding:0;background:${CREAM};`;
export const CANVAS_STYLE =
  `padding:32px 16px;background:${CREAM};font-family:${FONT_STACK};` +
  `font-size:16px;line-height:1.6;color:${BROWN};`;
/** The text an inbox lists beside the subject, hidden from the opened email. */
export const PREHEADER_STYLE =
  'display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;' +
  `font-size:1px;line-height:1px;color:${CREAM};`;
export const CARD_STYLE =
  `max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;` +
  'border-collapse:separate;overflow:hidden;';
export const MASTHEAD_STYLE = `padding:20px 32px;background:${GREEN};border-radius:11px 11px 0 0;`;
export const CONTENT_STYLE = 'padding:32px 32px 16px;';
export const HEADING_STYLE = `margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:700;color:${GREEN};`;
export const PARAGRAPH_STYLE = 'margin:0 0 16px;';
export const ACTION_STYLE =
  `display:inline-block;padding:12px 28px;background:${GREEN};color:${CREAM};` +
  'border-radius:999px;font-size:16px;line-height:1.5;font-weight:700;text-decoration:none;';
export const LINK_STYLE = `color:${GREEN};font-weight:600;text-decoration:underline;`;
export const FACT_LABEL_STYLE =
  `padding:4px 24px 4px 0;font-size:12px;line-height:24px;font-weight:600;letter-spacing:1px;` +
  `text-transform:uppercase;white-space:nowrap;color:${MUTED};`;
export const FACT_VALUE_STYLE = 'padding:4px 0;line-height:24px;font-weight:600;';
export const FOOTER_STYLE = `margin:16px 0 0;font-size:13px;text-align:center;color:${MUTED};`;

/** The masthead's wordmark: a chartreuse dot, after GBD's logo, and the name in cream. */
export const WORDMARK =
  `<span style="display:inline-block;width:10px;height:10px;margin-right:10px;border-radius:50%;background:${CHARTREUSE};vertical-align:middle;"></span>` +
  `<span style="font-size:18px;font-weight:700;letter-spacing:3px;color:${CREAM};vertical-align:middle;">${APP_NAME}</span>`;

export const FOOTER_HTML = `${APP_NAME} is a tool from <a href="${GBD_URL}" style="color:${MUTED};text-decoration:underline;">Greener by Default</a>.`;

function presentationTable(attributes: string, rows: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"${attributes}>${rows}</table>`;
}

function blockToHtml(block: Block): string {
  switch (block.block) {
    case 'paragraph':
      return `<p style="${PARAGRAPH_STYLE}">${escapeHtml(block.text)}</p>`;
    case 'action':
      // The `bgcolor` cell keeps a button behind the label where a client drops the link's own
      // padding and background, as Outlook does.
      return presentationTable(
        ' style="margin:24px 0;"',
        `<tr><td bgcolor="${GREEN}" style="border-radius:999px;">` +
          `<a href="${escapeHtml(block.url)}" style="${ACTION_STYLE}">${escapeHtml(block.label)}</a>` +
          '</td></tr>',
      );
    case 'links':
      return presentationTable(
        ` width="100%" style="margin:0 0 16px;border-top:1px solid ${BORDER};"`,
        block.links
          .map(
            (link) =>
              `<tr><td style="padding:12px 0;border-bottom:1px solid ${BORDER};">` +
              `<a href="${escapeHtml(link.url)}" style="${LINK_STYLE}">${escapeHtml(link.label)}</a>` +
              '</td></tr>',
          )
          .join(''),
      );
    case 'facts':
      return presentationTable(
        ` width="100%" bgcolor="${SAND}" style="margin:8px 0 16px;border-radius:12px;"`,
        `<tr><td style="padding:16px 20px;">${presentationTable(
          '',
          block.facts
            .map(
              ([label, value]) =>
                `<tr><th align="left" valign="top" style="${FACT_LABEL_STYLE}">${escapeHtml(label)}</th>` +
                `<td style="${FACT_VALUE_STYLE}">${escapeHtml(value)}</td></tr>`,
            )
            .join(''),
        )}</td></tr>`,
      );
    default:
      return assertNever(block);
  }
}

/** The first paragraph, so the inbox previews the message rather than the wordmark. */
function preheader(document: Document): string | undefined {
  return document.blocks.find((block) => block.block === 'paragraph')?.text;
}

export function renderHtml(document: Document): string {
  const heading = escapeHtml(document.heading);
  const preview = preheader(document);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
      `<title>${heading}</title></head>`,
    `<body style="${BODY_STYLE}">`,
    ...(preview === undefined
      ? []
      : [`<div style="${PREHEADER_STYLE}">${escapeHtml(preview)}</div>`]),
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="${CREAM}"><tr><td align="center" style="${CANVAS_STYLE}">`,
    '<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" width="560"><tr><td><![endif]-->',
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="${CARD_STYLE}">`,
    `<tr><td bgcolor="${GREEN}" style="${MASTHEAD_STYLE}">${WORDMARK}</td></tr>`,
    `<tr><td bgcolor="${CHARTREUSE}" height="4" style="height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>`,
    `<tr><td align="left" style="${CONTENT_STYLE}">`,
    `<h1 style="${HEADING_STYLE}">${heading}</h1>`,
    ...document.blocks.map(blockToHtml),
    '</td></tr>',
    '</table>',
    `<p style="${FOOTER_STYLE}">${FOOTER_HTML}</p>`,
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}
