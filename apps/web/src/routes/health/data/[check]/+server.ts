import { MINUTE_MS } from '@gbd/core';
import type { DatabaseExecutor } from '@gbd/db';
import { error } from '@sveltejs/kit';
import { database } from '#lib/server/db.js';
import { logger } from '#lib/server/log.js';
import type { RequestHandler } from './$types';
import { expiringCache } from './cache.ts';
import { DATA_CHECKS, type DataCheckName, isDataCheckName } from './checks.ts';

/** The body is the page an alert email links to. The route is public, like `/health/ready`, which
 * holds only while the body is counts: a check that needs attempt ids goes behind sign-in. A
 * failure's reason stays in the log, at `error`, where Better Stack's log alert also sees it. */
export type DataCheckReport =
  | {
      check: DataCheckName;
      status: 'ok' | 'firing';
      firing: string;
      count: number;
      threshold: number;
    }
  | { check: DataCheckName; status: 'error'; firing: string };

/** One data alert, polled by Better Stack (`checks.ts`). A check that cannot be evaluated answers
 * `error`, so a migration that breaks its query, or a database the web cannot reach, alerts
 * rather than going quiet. Never rejects. */
export async function _evaluateDataCheck(
  db: DatabaseExecutor,
  check: DataCheckName,
): Promise<DataCheckReport> {
  const { firing, measure } = DATA_CHECKS[check];
  try {
    const { count, threshold } = await measure(db);
    return { check, status: count > threshold ? 'firing' : 'ok', firing, count, threshold };
  } catch (cause) {
    logger().error({ err: cause, check }, 'Data check failed');
    return { check, status: 'error', firing };
  }
}

/** Anyone can call these routes, so however often they do, each check costs one query a minute
 * against the web's pool of five. `WEB_INSTANCES` is 1, so this process's cache is the whole
 * cache. */
const cachedReport = expiringCache<DataCheckName, Promise<DataCheckReport>>(MINUTE_MS);

export const GET: RequestHandler = async ({ params }) => {
  if (!isDataCheckName(params.check)) error(404, 'Not found', { code: 'not_found' });
  const { check } = params;
  const report = await cachedReport(check, () => _evaluateDataCheck(database(), check));
  return Response.json(report, { status: report.status === 'ok' ? 200 : 503 });
};
