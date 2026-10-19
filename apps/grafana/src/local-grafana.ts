/** A local Grafana in Docker, from `compose.yaml`. Like the Supabase stacks, it is one container per
 * stack that every worktree shares, since nothing in it comes from a worktree: dashboards are served
 * from disk by `gcx dev serve`, and the data source is upserted on every start. */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type LocalGrafana = {
  /** The Compose project, so each stack's container is separate. */
  project: string;
  /** Where Grafana listens on 127.0.0.1. Kept in sync with `gcx.yaml`. */
  port: number;
};

/** Beside the dev Supabase stack's 553xx ports. */
export const DEV_GRAFANA: LocalGrafana = { project: 'fsi-grafana-dev', port: 55330 };

/** Beside the test Supabase stack's 653xx ports. The panel check in `dashboards.test.ts` runs
 * against it. */
export const TEST_GRAFANA: LocalGrafana = { project: 'fsi-grafana-test', port: 65330 };

const COMPOSE_FILE = join(import.meta.dirname, '..', 'compose.yaml');

/** Generous, because the first start on a machine migrates Grafana's own database. */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 500;

/** How many times `startGrafana` runs `compose up`, for the race it describes. */
const UP_ATTEMPTS = 5;

export function grafanaUrl(grafana: LocalGrafana): string {
  return `http://127.0.0.1:${grafana.port}`;
}

/** Start the container if it is not running, and wait until Grafana answers.
 *
 * Safe to call from several worktrees at once:
 * - `--no-recreate`, because worktrees on different branches can hold different `compose.yaml`s,
 *   and Compose would otherwise replace the container whenever its config differs from the
 *   caller's. That would take Grafana down mid-run for every other worktree, along with the data
 *   sources they upserted. So a running container keeps its config until `stopGrafana`.
 * - Retries: callers that find no container race to create it, then to start it, and a loser fails
 *   on the container's name or its port. Once the winner's container is running, `up` just finds
 *   it.
 */
export async function startGrafana(grafana: LocalGrafana): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await compose(grafana, ['up', '--detach', '--no-recreate']);
      break;
    } catch (cause) {
      if (attempt === UP_ATTEMPTS) throw cause;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
  }
  await waitUntilHealthy(grafana);
}

export async function stopGrafana(grafana: LocalGrafana): Promise<void> {
  await compose(grafana, ['down']);
}

async function compose(grafana: LocalGrafana, args: string[]): Promise<void> {
  await run(
    'docker',
    ['compose', '--file', COMPOSE_FILE, '--project-name', grafana.project, ...args],
    {
      env: { ...process.env, GRAFANA_PORT: String(grafana.port) },
    },
  );
}

/** Docker's published port accepts a connection as soon as the container starts, well before
 * Grafana can answer, so this waits on Grafana's own health check instead. */
async function waitUntilHealthy(grafana: LocalGrafana): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${grafanaUrl(grafana)}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Grafana did not answer on port ${grafana.port} within ${READY_TIMEOUT_MS / 1000}s`,
  );
}
