import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOCALHOST } from '@gbd/core/testing';
import { describe, expect, onTestFinished, test } from 'vitest';
import type { RenderedEmail } from '../client.ts';
import { isEmailError } from '../errors.ts';
import { postmarkTransport } from './postmark.ts';

const TOKEN = 'server-token';

const EMAIL: RenderedEmail = {
  kind: 'analysis-succeeded',
  from: { address: 'insights@example.test', name: 'Foodservice Insights' },
  to: 'user@example.test',
  subject: 'Your report is ready',
  text: 'text',
  html: '<p>html</p>',
};

type Received = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
};

/** A stand-in for Postmark's API on a free port, answering every request with `respond`. */
async function fakePostmark(respond: (response: ServerResponse) => void) {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    received.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    respond(response);
  });

  await new Promise<void>((resolve) => server.listen(0, LOCALHOST, resolve));
  onTestFinished(async () => {
    // A request the server never answered would otherwise hold `close` open.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address() as AddressInfo;
  return { origin: `http://${LOCALHOST}:${port}`, received };
}

function answerJson(status: number, body: unknown) {
  return (response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
}

const ACCEPTED = answerJson(200, {
  To: EMAIL.to,
  SubmittedAt: '2026-10-14T12:00:00Z',
  MessageID: '0a129aee-e1cd-480d-b08d-4f48548ff48d',
  ErrorCode: 0,
  Message: 'OK',
});

async function sendThrough(
  origin: string,
  email: RenderedEmail = EMAIL,
  testTimeoutOverrideMs?: number,
): Promise<unknown> {
  return await postmarkTransport({
    serverToken: TOKEN,
    testOriginOverride: origin,
    testTimeoutOverrideMs,
  })
    .send(email)
    .catch((error: unknown) => error);
}

describe('postmarkTransport', () => {
  test('posts the email on the outbound stream, tagged by kind, with tracking off', async () => {
    const postmark = await fakePostmark(ACCEPTED);

    expect(await sendThrough(postmark.origin)).toBeUndefined();

    expect(postmark.received).toEqual([
      {
        method: 'POST',
        path: '/email',
        headers: expect.objectContaining({
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': TOKEN,
        }),
        body: {
          From: '"Foodservice Insights" <insights@example.test>',
          To: 'user@example.test',
          Subject: 'Your report is ready',
          TextBody: 'text',
          HtmlBody: '<p>html</p>',
          MessageStream: 'outbound',
          Tag: 'analysis-succeeded',
          TrackOpens: false,
          TrackLinks: 'None',
        },
      },
    ]);
  });

  test('escapes a quote in the display name, so the From stays one address', async () => {
    const postmark = await fakePostmark(ACCEPTED);

    await sendThrough(postmark.origin, {
      ...EMAIL,
      from: { ...EMAIL.from, name: 'Say "hi", \\ friend' },
    });

    expect(postmark.received[0]?.body).toMatchObject({
      From: '"Say \\"hi\\", \\\\ friend" <insights@example.test>',
    });
  });

  test("reports a suppressed recipient by ErrorCode, without Postmark's message naming them", async () => {
    const postmark = await fakePostmark(
      answerJson(422, {
        ErrorCode: 406,
        Message:
          'You tried to send to recipient(s) that have been marked as inactive. ' +
          'Found inactive addresses: user@example.test.',
      }),
    );

    const thrown = await sendThrough(postmark.origin);

    expect(isEmailError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe('postmark send of analysis-succeeded failed');
    expect(((thrown as Error).cause as Error).message).toBe(
      'postmark answered 422 with ErrorCode 406',
    );
  });

  test('reports a failure whose body is not JSON by status alone', async () => {
    const postmark = await fakePostmark((response) => {
      response.writeHead(503, { 'content-type': 'text/html' }).end('<h1>Service Unavailable</h1>');
    });

    const thrown = await sendThrough(postmark.origin);

    expect(isEmailError(thrown)).toBe(true);
    expect(((thrown as Error).cause as Error).message).toBe(
      'postmark answered 503 with ErrorCode unknown',
    );
  });

  test('gives up on a server that never answers once the timeout passes', async () => {
    const postmark = await fakePostmark(() => {});

    const thrown = await sendThrough(postmark.origin, EMAIL, 100);

    expect(isEmailError(thrown)).toBe(true);
    expect(((thrown as Error).cause as Error).name).toBe('TimeoutError');
  });
});
