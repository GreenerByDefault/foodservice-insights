import type { Logger } from '@gbd/core/log';
import { rootLogger } from './root-log.ts';

/** The logger every server line goes through. */
export function logger(): Logger {
  return rootLogger();
}
