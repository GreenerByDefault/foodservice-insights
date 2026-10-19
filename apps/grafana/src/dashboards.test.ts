import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTHETIC_HISTORY_SPAN_MS } from '@gbd/db/testing';
import { describe, expect, inject, test } from 'vitest';
import { parse } from 'yaml';
import { DATA_SOURCE_UID } from './data-source.ts';
import { grafanaUrl, TEST_GRAFANA } from './local-grafana.ts';

/** The one version `gcx dev serve` can serve; see the README. */
const DASHBOARD_API_VERSION = 'dashboard.grafana.app/v2beta1';

const DASHBOARDS_DIR = join(import.meta.dirname, '..', 'resources', 'dashboards');

/** Past each end of the synthetic history, since it was written a few seconds before the check
 * runs, and the clock of Docker's VM can drift from this machine's. */
const RANGE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** The parts of a `v2beta1` dashboard file the check reads. */
type DashboardFile = {
  apiVersion: string;
  spec: {
    title: string;
    elements: Record<string, { kind: string; spec: PanelSpec }>;
  };
};

type PanelSpec = {
  title: string;
  data: { spec: { queries: { spec: { refId: string; query: PanelQuery } }[] } };
};

type PanelQuery = {
  datasource: { name: string };
  spec: { rawSql: string; format: string };
};

const dashboards = readdirSync(DASHBOARDS_DIR)
  .filter((file) => file.endsWith('.yaml'))
  .map((file) => ({
    file,
    dashboard: parse(readFileSync(join(DASHBOARDS_DIR, file), 'utf8')) as DashboardFile,
  }));

describe.each(dashboards)('$file', ({ dashboard }) => {
  test(`is at ${DASHBOARD_API_VERSION}`, () => {
    expect(dashboard.apiVersion).toBe(DASHBOARD_API_VERSION);
  });

  const elements = Object.values(dashboard.spec.elements);

  // The check reads only inline panels, so a library panel would go unchecked.
  test('holds only inline panels', () => {
    expect(elements.map(({ kind }) => kind)).toEqual(elements.map(() => 'Panel'));
  });

  const panels = elements.filter(({ kind }) => kind === 'Panel').map(({ spec }) => spec);

  describe.each(panels)(`${dashboard.spec.title} › $title`, (panel) => {
    const queries = panel.data.spec.queries.map(({ spec }) => spec);

    test(`queries the ${DATA_SOURCE_UID} data source`, () => {
      expect(queries.map(({ query }) => query.datasource.name)).toEqual(
        queries.map(() => DATA_SOURCE_UID),
      );
    });

    test.each(queries)('query $refId returns rows from the synthetic history', async (query) => {
      expect(await countRows(query.refId, query.query)).toBeGreaterThan(0);
    });
  });
});

/** Run a panel's query through Grafana, so Grafana expands its own macros, against this run's
 * data source rather than the `metrics` the file names. */
async function countRows(refId: string, query: PanelQuery): Promise<number> {
  const now = Date.now();
  const response = await fetch(new URL('/api/ds/query', grafanaUrl(TEST_GRAFANA)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: String(now - SYNTHETIC_HISTORY_SPAN_MS - RANGE_MARGIN_MS),
      to: String(now + RANGE_MARGIN_MS),
      queries: [
        {
          ...query.spec,
          refId,
          datasource: { uid: inject('runDataSourceUid') },
          rawQuery: true,
          intervalMs: RANGE_MARGIN_MS,
          maxDataPoints: 1000,
        },
      ],
    }),
  });
  const body = (await response.json()) as QueryResponse;
  const result = body.results?.[refId];
  if (!response.ok || result === undefined || result.error !== undefined) {
    throw new Error(`Grafana answered ${response.status}: ${result?.error ?? body.message}`);
  }
  return result.frames
    .map((frame) => frame.data.values[0]?.length ?? 0)
    .reduce((total, rows) => total + rows, 0);
}

type QueryResponse = {
  message?: string;
  results?: Record<
    string,
    { error?: string; frames: { data: { values: unknown[][] } }[] } | undefined
  >;
};
