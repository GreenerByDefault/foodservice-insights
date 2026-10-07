import type { Logger } from '@gbd/core/log';
import type { RequestEvent } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { rootLogger } from './root-log.ts';

/** The logger every server line goes through: inside a request, that request's own, so the line
 * carries its id with no `event` passed down to the helper writing it. */
export function logger(): Logger {
  return currentRequest()?.locals.log ?? rootLogger();
}

/** Bind `requestId` to every line written through `logger()` while `event` is being handled. */
export function bindRequestLogger(event: RequestEvent, requestId: string): void {
  event.locals.log = rootLogger().child({ requestId });
}

function currentRequest(): RequestEvent | undefined {
  try {
    return getRequestEvent();
  } catch {
    // Outside a request: `init`, the process handlers, or a test calling a helper directly.
    return undefined;
  }
}
