/** Renders every email kind to disk so a human can eyeball the HTML and text bodies.
 *
 * Output goes to `.preview/`, gitignored, one HTML and one text file per message kind. Not
 * part of `test` or `check` — this is for a human to look at, not something CI asserts on.
 *
 * Usage: `pnpm --filter @gbd/email preview`, then open `.preview/index.html`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { render } from '../src/messages/index.ts';
import { allMessages } from '../src/testing/fixtures.ts';
import { recordingEmailer } from '../src/testing/recording.ts';

const OUT_DIR = path.join(import.meta.dirname, '..', '.preview');
const RECIPIENT = 'alice@example.test';

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const emailer = recordingEmailer().service;
  const emails = allMessages(RECIPIENT).map((message) => render(emailer, message));

  await Promise.all(
    emails.flatMap((email) => [
      writeFile(path.join(OUT_DIR, `${email.kind}.html`), email.html),
      writeFile(path.join(OUT_DIR, `${email.kind}.txt`), email.text),
    ]),
  );

  const index = [
    '<!doctype html>',
    '<title>Email previews</title>',
    '<h1>Email previews</h1>',
    '<ul>',
    ...emails.map(
      (email) =>
        `<li><code>${email.subject}</code> — ${email.kind}: ` +
        `<a href="${email.kind}.html">html</a> / <a href="${email.kind}.txt">text</a></li>`,
    ),
    '</ul>',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'index.html'), index);

  console.log(`Wrote ${emails.length} previews to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

await main();
