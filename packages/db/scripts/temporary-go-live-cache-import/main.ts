// Temporary: the go-live import of GBD's cache CSVs. README.md says how to run it; this directory
// is deleted after the final import. See target.ts for how --production differs from a local run.

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findRepoRoot } from '@gbd/core/env';
import { initializeDatabase, shutdownDatabase } from '../../src/client.ts';
import {
  CATEGORIES_YAML_PATH,
  type Cleaned,
  categoryVocabulary,
  cleanEntreeClassifications,
  cleanProductCategorizations,
  ENTREE_COLUMNS,
  type Note,
  PRODUCT_COLUMNS,
} from './clean.ts';
import { readCsv } from './csv.ts';
import {
  ask,
  connectionFor,
  describeConnectionString,
  importsAroundRefusedRows,
  type Target,
} from './target.ts';
import {
  type ImportCounts,
  importInOneTransaction,
  type TableImport,
  upsertEntreeClassifications,
  upsertProductCategorizations,
} from './upsert.ts';

type PlannedImport = TableImport & {
  path: string;
  recordCount: number;
  cleaned: Cleaned<unknown>;
};

const { values: args } = parseArgs({
  options: {
    products: { type: 'string' },
    entrees: { type: 'string' },
    write: { type: 'boolean', default: false },
    production: { type: 'boolean', default: false },
    mirror: { type: 'boolean', default: false },
  },
  strict: true,
});

async function main(): Promise<number> {
  const target: Target = args.production ? 'production' : 'local';
  const imports = planImports();
  if (imports.length === 0) {
    console.error('Pass at least one of --products and --entrees.');
    return 1;
  }
  for (const planned of imports) printCleaning(planned);
  if (imports.some(({ cleaned }) => cleaned.refused.length > 0)) {
    if (!importsAroundRefusedRows(target, args)) {
      console.error('\nRefused: fix the rows above in the CSV, then run this again.');
      return 1;
    }
    console.log('\n--mirror imports without the refused rows. Production would refuse to run.');
  }

  const { connectionString, sslCa } = await connectionFor(target);
  const description = describeConnectionString(connectionString);
  console.log(`\nTarget: ${target === 'production' ? 'PRODUCTION' : 'local'}, ${description}`);

  const database = initializeDatabase({
    connectionString,
    sslCa,
    // Long enough for a person to read the counts before confirming a production commit, during
    // which the transaction is open.
    limits: { minConnections: 0, maxConnections: 1, idleInTransactionSessionTimeoutMs: 1_800_000 },
    log: 'console',
    siteUrl: process.env.SITE_URL,
    // `--production` connects as `postgres`, behind target.ts's checks and a typed COMMIT.
    hostedFromACheckout: 'temporary-go-live-cache-import',
  });
  try {
    const { committed } = await importInOneTransaction(
      database,
      imports,
      { mirror: args.mirror },
      async (counts) => {
        printCounts(imports, counts);
        if (!args.write) return false;
        if (target === 'local') return true;
        const change = args.mirror ? 'replace every row of these tables in' : 'write these rows to';
        const answer = await ask(
          `\nType COMMIT to ${change} ${description}. Anything else rolls back: `,
        );
        return answer === 'COMMIT';
      },
    );
    if (committed) console.log('\nCommitted.');
    else if (args.write) console.log('\nRolled back: not confirmed.');
    else console.log('\nDry run: rolled back. Run again with --write to commit.');
  } finally {
    await shutdownDatabase(database);
  }
  return 0;
}

function planImports(): PlannedImport[] {
  const imports: PlannedImport[] = [];

  if (args.products) {
    const path = resolveFromInvocation(args.products);
    const records = readCsv(readFileSync(path, 'utf8'), PRODUCT_COLUMNS);
    const yaml = readFileSync(join(findRepoRoot(), CATEGORIES_YAML_PATH), 'utf8');
    const cleaned = cleanProductCategorizations(records, categoryVocabulary(yaml));
    imports.push({
      table: 'product_categorization',
      path,
      recordCount: records.length,
      cleaned,
      upsert: (db) => upsertProductCategorizations(db, cleaned.rows, suggestedBy(path)),
    });
  }

  if (args.entrees) {
    const path = resolveFromInvocation(args.entrees);
    // Files from before the lab recorded cleaned names have no such column.
    const records = readCsv(readFileSync(path, 'utf8'), ENTREE_COLUMNS, ['cleaned_item_names']);
    const cleaned = cleanEntreeClassifications(records);
    imports.push({
      table: 'entree_classification',
      path,
      recordCount: records.length,
      cleaned,
      upsert: (db) => upsertEntreeClassifications(db, cleaned.rows, suggestedBy(path)),
    });
  }

  return imports;
}

/** pnpm runs the script from `packages/db`, so a relative path means where the person typed it,
 * which pnpm records in `INIT_CWD`. */
function resolveFromInvocation(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function suggestedBy(path: string): string {
  return `import:${basename(path)}`;
}

function printCleaning({ path, table, recordCount, cleaned }: PlannedImport): void {
  console.log(`\n${path} → ${table}`);
  console.log(`  ${recordCount} rows read, ${cleaned.rows.length} to import`);
  printNotes('skipped', cleaned.skipped);
  printNotes('rewrote', cleaned.rewritten);
  printNotes('REFUSED', cleaned.refused);
}

const MAX_LINES_SHOWN = 20;

/** One line per reason, with how many rows had it and where. */
function printNotes(verb: string, notes: readonly Note[]): void {
  const linesByReason = Map.groupBy(notes, (note) => note.reason);
  for (const [reason, group] of linesByReason) {
    const lines = group.map((note) => note.line);
    const shown = lines.slice(0, MAX_LINES_SHOWN).join(', ');
    const more =
      lines.length > MAX_LINES_SHOWN ? `, and ${lines.length - MAX_LINES_SHOWN} more` : '';
    console.log(`  ${verb} ${lines.length} × ${reason}: line ${shown}${more}`);
  }
}

function printCounts(imports: readonly PlannedImport[], counts: readonly ImportCounts[]): void {
  console.log('');
  imports.forEach(({ table }, index) => {
    const { deleted, inserted, promoted, alreadyVerified } = counts[index] as ImportCounts;
    const deletion = args.mirror ? `${deleted} deleted, ` : '';
    console.log(
      `${table}: ${deletion}${inserted} inserted, ${promoted} promoted from unverified, ` +
        `${alreadyVerified} left alone as already verified`,
    );
  });
}

process.exitCode = await main();
