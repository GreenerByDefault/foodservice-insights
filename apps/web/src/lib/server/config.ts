import { authMode } from '#lib/auth/mode.js';
import { supabaseProject } from './auth/identify.ts';
import { database } from './db.ts';
import { emailer } from './email.ts';
import { rootLogger } from './root-log.ts';
import { blobStore } from './storage.ts';

/** Build every handle a request may need, so a missing or malformed variable stops the server at
 * startup — and with it the deploy, whose health check then never passes — rather than failing the
 * first request that reads it.
 *
 * It checks handles, not a list of variables, so a variable added to one of these is covered with
 * no change here. A new handle still needs a line. Nothing here connects to anything: `/health`
 * owns reachability.
 */
export function assertConfigured(): void {
  rootLogger();
  database();
  blobStore();
  emailer();
  authMode();
  supabaseProject();
}
