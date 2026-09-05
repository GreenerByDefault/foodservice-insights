/** Builds and runs the two service images this tier tests through.
 *
 * Nothing else in the repo builds `apps/web/Dockerfile` or `apps/worker/Dockerfile`, so this is
 * the only thing that proves they work. The worker image is the reason it matters: a
 * `--no-editable` `worker_child` in a venv, `PYTHON_BIN`, and a `WORKER_RUN_ROOT` writable as uid
 * 1001 are a layout that exists nowhere else, there is no worker health check to probe, and the
 * only way to exercise any of it is to run a real report through it. So the images are what this
 * tier runs, and — with no host-process path left — the only thing it can run.
 *
 * ## Why `host.docker.internal`, on both sides
 *
 * Containers reach the host's Supabase and Mailpit through it (`--add-host`), and the *host* has
 * to resolve it too, via the `/etc/hosts` line `assertDockerIsUsable` names. That second half is
 * forced rather than chosen: a presigned blob-store URL carries `X-Amz-SignedHeaders=host`, so
 * its host is inside the signature and cannot be rewritten afterwards (confirmed empirically —
 * see `.claude/plans/chart-screenshots.md`). The web container therefore has to sign with the
 * exact name the browser will follow the 302 to, and one name resolving on both sides is the
 * only shape that satisfies both ends.
 *
 * *`--network host` would need no `/etc/hosts` entry, and is what CI would happily use. It is out
 * because on macOS the host cannot reach such a container's published port at all.*
 */

import { execFile, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { requireEnv } from '@gbd/core/env';

const execFileAsync = promisify(execFile);

/** Resolves to the host from inside a container via `--add-host`, and on the host itself via the
 * `/etc/hosts` line. */
const HOST_ALIAS = 'host.docker.internal';

const SERVICES = ['web', 'worker'] as const;
type Service = (typeof SERVICES)[number];

/** Carried by every image and container this suite creates, so leftovers from a run killed before
 * its own teardown can still be found. Value is the run name. */
const RUN_LABEL = 'gbd-system-e2e-run';
/** Value is `Date.now()` at creation. Docker knows its own creation times, but only in a string
 * format that is a nuisance to parse; a number we wrote ourselves is not. */
const STARTED_LABEL = 'gbd-system-e2e-started';

/** Value is the pid of the harness process that started the container.
 *
 * This is what makes an abandoned container recoverable. `turbo` force-kills its task subtree on
 * a Ctrl-C — "Force killed Turborepo tasks" — so the harness dies by SIGKILL and *no* in-process
 * teardown can be relied on: not a signal handler, not a `finally`. The container then outlives
 * its client, reparented to pid 1, holding a connection that makes the run database both
 * undroppable and unsweepable (`sweepStaleRunDatabases` gates on having no connections).
 *
 * So the next run cleans up instead, and this label is how it tells an orphan from a concurrent
 * worktree's live container: the owner of a live one is still running.
 */
const OWNER_LABEL = 'gbd-system-e2e-owner-pid';

/** Matches `sweepStaleRunDatabases`. The backstop for a container whose owning pid has been
 * recycled, or which was started on a different machine than the one sweeping. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Set by `test-run.ts` for the Playwright child, and the thing `assertBuiltContainerImages`
 * looks for. */
const IMAGE_ENV_VARS: Record<Service, string> = {
  web: 'SYSTEM_E2E_WEB_IMAGE',
  worker: 'SYSTEM_E2E_WORKER_IMAGE',
};

export type ContainerImages = Record<Service, string>;

/** The run-scoped values `runAgainstFreshStack` created. They reach the two callers by different
 * routes — `test-run.ts` has the `FreshStack` itself, `playwright.config.ts` reads what was
 * exported into its environment — so they are passed in rather than read from a global. */
export type ContainerStack = {
  connectionString: string;
  s3Bucket: string;
  siteUrl: string;
};

function imageTag(service: Service, runName: string): string {
  return `gbd-${service}:${runName}`;
}

function containerName(service: Service, runName: string): string {
  return `gbd-${service}-${runName}`;
}

/** Throws unless `test-run.ts` built the images for this run. The sibling of `assertTestRunId`,
 * and for the same reason: a bare `playwright test` would otherwise run against whatever the
 * config happened to compose, and the images — the entire point of this tier — would go
 * untested. */
export function assertBuiltContainerImages(): ContainerImages {
  const missing = SERVICES.filter((service) => !process.env[IMAGE_ENV_VARS[service]]);
  if (missing.length > 0) {
    throw new Error(
      `${missing.map((service) => IMAGE_ENV_VARS[service]).join(' and ')} not set. This suite ` +
        'runs the web and worker Docker images, which `pnpm test:system` builds — run it through ' +
        'that, never `playwright test` directly.',
    );
  }
  return {
    web: requireEnv(IMAGE_ENV_VARS.web),
    worker: requireEnv(IMAGE_ENV_VARS.worker),
  };
}

/** The run-scoped values, as `runAgainstFreshStack` exported them to the Playwright child. */
export function containerStackFromEnv(): ContainerStack {
  return {
    connectionString: requireEnv('DB_CONNECTION_STRING'),
    s3Bucket: requireEnv('S3_BUCKET'),
    siteUrl: requireEnv('SITE_URL'),
  };
}

/** Both preconditions this suite has beyond the test stack, checked before anything slow runs.
 * Either one missing otherwise surfaces a long way from its cause — a Docker daemon as a build
 * failure, the host alias as an opaque 60s webServer timeout. */
export async function assertDockerIsUsable(): Promise<void> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch (cause) {
    throw new Error(
      'test-run: could not reach a Docker daemon. `pnpm test:system` runs the web and worker ' +
        'images, so Docker has to be running — see README.md.',
      { cause },
    );
  }

  try {
    await lookup(HOST_ALIAS);
  } catch (cause) {
    throw new Error(
      `test-run: this machine does not resolve ${HOST_ALIAS}, which the browser needs in order ` +
        'to follow a report download to the blob store. Add it once:\n\n' +
        `  sudo sh -c 'echo "127.0.0.1 ${HOST_ALIAS}" >> /etc/hosts'\n`,
      { cause },
    );
  }
}

function runInherited(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`));
    });
  });
}

/** Builds both images from the repo root, every run.
 *
 * Always building *is* the freshness guarantee — there is no staleness check to get wrong, and
 * BuildKit makes an unchanged rebuild seconds. Sequential rather than parallel so the progress
 * output stays readable; they share most of their base layers anyway.
 */
export async function buildContainerImages(
  repoRoot: string,
  runName: string,
): Promise<ContainerImages> {
  const built: Partial<ContainerImages> = {};
  for (const service of SERVICES) {
    const tag = imageTag(service, runName);
    await runInherited('docker', [
      // `buildx build --load`, not `build`: a contributor who has ever run `docker buildx create
      // --use` has the `docker-container` driver, where a plain build populates only the cache and
      // leaves nothing for `docker run` to find.
      'buildx',
      'build',
      '--load',
      // Every base image floats on `:latest`, so CI resolves today's and would drift from a
      // months-old local cache. CI is where that drift should surface; locally it would just make
      // the suite need the network on every run.
      ...(process.env.CI ? ['--pull'] : []),
      // Absolute: `--file` resolves against the cwd, which is this package, not the build context.
      '--file',
      path.join(repoRoot, 'apps', service, 'Dockerfile'),
      '--tag',
      tag,
      '--label',
      `${RUN_LABEL}=${runName}`,
      '--label',
      `${STARTED_LABEL}=${Date.now()}`,
      repoRoot,
    ]);
    built[service] = tag;
  }
  return built as ContainerImages;
}

/** Swaps a host loopback URL for the alias that resolves on both sides. Applied to everything a
 * container dials — and, for the blob store, to what it *signs*; see this file's header. */
function forContainer(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return url;
  parsed.hostname = HOST_ALIAS;
  return parsed.toString();
}

/** What both images need from the host's environment.
 *
 * `PYTHON_BIN` and `WORKER_RUN_ROOT` are deliberately absent, and must stay that way: each image
 * sets its own, and `.env.test`'s host values — a `.venv/bin/python` relative to a repo root the
 * image doesn't have — would break the worker if they leaked in.
 */
function sharedEnv(stack: ContainerStack): Record<string, string> {
  return {
    DB_CONNECTION_STRING: forContainer(stack.connectionString),
    S3_ENDPOINT: forContainer(requireEnv('S3_ENDPOINT')),
    S3_REGION: requireEnv('S3_REGION'),
    S3_ACCESS_KEY_ID: requireEnv('S3_ACCESS_KEY_ID'),
    S3_SECRET_ACCESS_KEY: requireEnv('S3_SECRET_ACCESS_KEY'),
    S3_BUCKET: stack.s3Bucket,
    // The web app reads this one too, for the report page's support link.
    EMAIL_SUPPORT_ADDRESS: requireEnv('EMAIL_SUPPORT_ADDRESS'),
    // Also read by the web app, where it picks the report page's poll interval. Missing, that is
    // not an error — just a page polling every 10s against specs that budget 60s for the whole
    // lifecycle, which passes locally and flakes on a loaded runner.
    WORKER_MODE: requireEnv('WORKER_MODE'),
  };
}

/** `NAME=value`, always — a bare `-e NAME` forwards the *CLI's* value, which `loadLocalEnv` has
 * already filled from `.env.test`, quietly reimposing the host's environment on the image. */
function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
}

function baseRunArgs(service: Service, runName: string): string[] {
  return [
    'run',
    '--rm',
    `--name=${containerName(service, runName)}`,
    `--label=${RUN_LABEL}=${runName}`,
    `--label=${STARTED_LABEL}=${Date.now()}`,
    `--label=${OWNER_LABEL}=${process.pid}`,
    `--add-host=${HOST_ALIAS}:host-gateway`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The `webServer.command` for `playwright.config.ts`.
 *
 * Everything the app needs is an `--env` flag rather than `webServer.env`, which Playwright would
 * set on the `docker` CLI and never pass through to the container.
 */
export function webContainerCommand(options: {
  image: string;
  runName: string;
  port: number;
  baseURL: string;
  stack: ContainerStack;
}): string {
  const { image, runName, port, baseURL, stack } = options;
  const args = [
    ...baseRunArgs('web', runName),
    // Loopback-only, and the same number inside and out so `PORT`, `ORIGIN` and `baseURL` stay
    // the one value the rest of the harness already agrees on.
    `--publish=127.0.0.1:${port}:${port}`,
    ...envFlags({
      PORT: String(port),
      // The browser reaches the container through the published port, so the origin it sends is
      // still the host's — SvelteKit's CSRF check 403s the upload otherwise.
      ORIGIN: baseURL,
      ...sharedEnv(stack),
    }),
    image,
  ];
  return ['docker', ...args].map(shellQuote).join(' ');
}

export type RunningWorker = { stop(): Promise<void> };

/** How long the container gets to drain after SIGTERM. Comfortably above the `stubbed` profile's
 * `killGraceMs` of 5s, so a worker still killing a child is not cut off mid-teardown — though it
 * is below `drainGraceMs` (30s), so what this exercises is a truncated drain. */
const WORKER_SHUTDOWN_TIMEOUT_SECONDS = 15;

/** Starts the worker image, attached, so its logs stay in the run's output.
 *
 * `docker stop` sends SIGTERM to PID 1, which is what the image's `exec node` form is for — under
 * `pnpm` the signal would stop at pnpm and the drain would never run. Killing the container also
 * takes the Python child with it; a host worker uses `detached: true` for the child, so a hard
 * kill there orphans it.
 */
export function startWorkerContainer(options: {
  image: string;
  runName: string;
  stack: ContainerStack;
}): RunningWorker {
  const { image, runName, stack } = options;
  const name = containerName('worker', runName);

  const container = spawn(
    'docker',
    [
      ...baseRunArgs('worker', runName),
      ...envFlags({
        ...sharedEnv(stack),
        SITE_URL: stack.siteUrl,
        EMAIL_TRANSPORT: requireEnv('EMAIL_TRANSPORT'),
        EMAIL_ENDPOINT: forContainer(requireEnv('EMAIL_ENDPOINT')),
        EMAIL_FROM_ADDRESS: requireEnv('EMAIL_FROM_ADDRESS'),
        EMAIL_GBD_ADDRESS: requireEnv('EMAIL_GBD_ADDRESS'),
      }),
      image,
    ],
    { stdio: 'inherit' },
  );

  // The worker logs nothing on a successful start, so there is no readiness line to wait for — and
  // a worker that dies at startup (an absent bucket, a broken venv in the image) would otherwise
  // show up only as an opaque assertion timeout a minute into the first spec. `stopping` is what
  // tells that apart from the shutdown below, where it drains and exits under its own power.
  let stopping = false;
  container.on('exit', (code) => {
    if (stopping) return;
    console.error(`test-run: the worker exited on its own with code ${code}; specs will now fail`);
  });

  const exited = new Promise<void>((resolve) => {
    if (container.exitCode !== null || container.signalCode !== null) {
      resolve();
      return;
    }
    container.once('exit', () => resolve());
  });

  return {
    stop: async () => {
      stopping = true;
      // Stop the *container*, not the CLI: signalling the client would leave the container behind
      // if it were ever detached, and this way the grace period is Docker's to enforce.
      await execFileAsync('docker', [
        'stop',
        `--time=${WORKER_SHUTDOWN_TIMEOUT_SECONDS}`,
        name,
      ]).catch(() => undefined);
      await exited;
      await removeContainer(name);
    },
  };
}

/** `docker rm --force` on a name that isn't there is an error, and an uninteresting one. */
export async function removeContainer(name: string): Promise<void> {
  await execFileAsync('docker', ['rm', '--force', name]).catch(() => undefined);
}

/** Removes this run's containers and image tags. Safe to call twice, and safe to call on things
 * that already tore themselves down. */
export async function removeRunResources(runName: string): Promise<void> {
  for (const service of SERVICES) {
    await removeContainer(containerName(service, runName));
    await execFileAsync('docker', ['rmi', '--force', imageTag(service, runName)]).catch(
      () => undefined,
    );
  }
}

async function labelled(subcommand: 'ps' | 'images', format: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', [
    subcommand,
    ...(subcommand === 'ps' ? ['--all'] : []),
    '--filter',
    `label=${RUN_LABEL}`,
    '--format',
    format,
  ]).catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

function isStale(startedAt: string): boolean {
  const started = Number(startedAt);
  if (Number.isNaN(started) || started === 0) return false;
  return Date.now() - started > STALE_AFTER_MS;
}

/** Whether the harness that started a container is still running. `EPERM` means the pid exists
 * but belongs to another user, which is still alive for this purpose. */
function ownerIsAlive(ownerPid: string): boolean {
  const pid = Number(ownerPid);
  if (Number.isNaN(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Best-effort, like the database and bucket sweeps: whatever this misses, the next run's sweep
 * gets another chance at.
 *
 * A dead owner is the real gate rather than age, because that is the case worth catching quickly:
 * the run database an abandoned container is connected to cannot be dropped or swept until the
 * container is gone. See `OWNER_LABEL` for why no teardown inside the harness can do this instead.
 */
export async function sweepStaleContainers(): Promise<number> {
  const staleContainers = (
    await labelled('ps', `{{.Names}}\t{{.Label "${STARTED_LABEL}"}}\t{{.Label "${OWNER_LABEL}"}}`)
  )
    .map((line) => line.split('\t'))
    .filter(([, startedAt, ownerPid]) => !ownerIsAlive(ownerPid ?? '') || isStale(startedAt ?? ''))
    .map(([name]) => name ?? '');

  for (const name of staleContainers) {
    await removeContainer(name);
  }

  // The tags those containers came from are orphaned the moment the containers are gone, so take
  // them now rather than leaving them to the age gate.
  const abandonedRuns = new Set(
    staleContainers.flatMap((name) =>
      SERVICES.filter((service) => name.startsWith(`gbd-${service}-`)).map((service) =>
        name.slice(`gbd-${service}-`.length),
      ),
    ),
  );
  const staleTags = [
    ...[...abandonedRuns].flatMap((runName) =>
      SERVICES.map((service) => imageTag(service, runName)),
    ),
    ...(await staleImageTags()),
  ];
  for (const tag of new Set(staleTags)) {
    await execFileAsync('docker', ['rmi', '--force', tag]).catch(() => undefined);
  }

  return staleContainers.length + staleTags.length;
}

/** `docker ps --format` understands `{{.Label}}`; `docker images --format` does not, so an image's
 * label has to be inspected one at a time. Only ever a handful, and only ones we tagged.
 *
 * Aged independently of any container rather than paired with one, so a build that fails after
 * tagging the first of the two images still gets its leftover cleaned up.
 */
async function staleImageTags(): Promise<string[]> {
  const tags = await labelled('images', '{{.Repository}}:{{.Tag}}');
  const stale: string[] = [];
  for (const tag of tags) {
    const { stdout } = await execFileAsync('docker', [
      'image',
      'inspect',
      tag,
      '--format',
      `{{index .Config.Labels "${STARTED_LABEL}"}}`,
    ]).catch(() => ({ stdout: '' }));
    if (isStale(stdout.trim())) stale.push(tag);
  }
  return stale;
}
