// Temporary: part of the go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted after the final import.
//
// Pure functions from CSV records to rows each table's checks accept. A row the pipeline could
// still use after an obvious fix is fixed; a row nobody could use is skipped; a row only a human
// can fix makes the import refuse, so it is fixed in the CSV rather than imported verified and
// wrong. A verified row blocks every later suggestion for its key, so a wrong one is never
// corrected by the pipeline.

import { MAX_CACHE_KEY_BYTES } from '../../src/constraints.ts';
import type EntreeClassificationLabel from '../../src/generated/public/EntreeClassificationLabel.ts';
import type { CsvRecord } from './csv.ts';

export const NO_MATCHES_FOUND = 'No Matches Found';

/** Relative to the repo root. */
export const CATEGORIES_YAML_PATH =
  'python/insights/gbd_foodservice_insights/data_files/GBD_categories.yaml';

export const PRODUCT_COLUMNS = ['product', 'category', 'cleaned_item_names'] as const;
export const ENTREE_COLUMNS = ['product', 'entree_classification', 'cleaned_item_names'] as const;
export const UNIT_COLUMNS = [
  'original_unit',
  'llm_cleaned_unit',
  'llm_extracted_weight',
  'example_products',
] as const;

export type ProductColumn = (typeof PRODUCT_COLUMNS)[number];
export type EntreeColumn = (typeof ENTREE_COLUMNS)[number];
export type UnitColumn = (typeof UNIT_COLUMNS)[number];

export type ProductCategorizationRow = {
  product: string;
  category: string;
  cleanedName: string | null;
};
export type EntreeClassificationRow = {
  product: string;
  classification: EntreeClassificationLabel;
  cleanedName: string | null;
};
export type UnitWeightRow = {
  originalUnit: string;
  cleanedUnit: string;
  extractedWeight: number | null;
  exampleProducts: string | null;
};

export type Note = { line: number; reason: string };

export type Cleaned<Row> = {
  rows: Row[];
  /** Left out; the import runs without them. */
  skipped: Note[];
  /** Imported with a value other than the file's. */
  rewritten: Note[];
  /** Fixable only in the CSV; any one of these makes the import refuse to run. */
  refused: Note[];
};

/** The categories a product may have: each `cool_food_pledge_name` in `GBD_categories.yaml`,
 * which is what `category_names()` returns, plus `No Matches Found`.
 *
 * Read line by line rather than with a YAML parser, which this short-lived script does not
 * warrant; `clean.test.ts` reads the real file, so a change of format fails there.
 */
export function categoryVocabulary(yaml: string): string[] {
  const names = yaml
    .split('\n')
    .filter((line) => line.startsWith('  cool_food_pledge_name:'))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
  if (names.length === 0) throw new Error('Found no cool_food_pledge_name in the categories YAML');
  const quoted = names.filter((name) => /^["']/.test(name));
  if (quoted.length > 0) throw new Error(`Cannot read quoted YAML values: ${quoted}`);
  return [...names, NO_MATCHES_FOUND];
}

export function cleanProductCategorizations(
  records: readonly CsvRecord<ProductColumn>[],
  vocabulary: readonly string[],
): Cleaned<ProductCategorizationRow> {
  const byLowercase = new Map(vocabulary.map((name) => [name.toLowerCase(), name]));

  const outcomes = records.map(({ line, values }): Outcome<ProductCategorizationRow> => {
    const product = stripLikePython(values.product);
    const category = values.category.trim();
    if (product === '') return { kind: 'skip', line, reason: 'blank product' };
    if (category === '') return { kind: 'skip', line, reason: 'blank category' };
    const keyProblem = checkKey(product);
    if (keyProblem) return { kind: 'refuse', line, reason: keyProblem };

    // The pipeline matches categories exactly, so a known name in the wrong case would be
    // dropped by every run; any other unknown name needs a human to say what was meant.
    const known = byLowercase.get(category.toLowerCase());
    if (known === undefined) {
      return { kind: 'refuse', line, reason: `unknown category ${JSON.stringify(category)}` };
    }
    return {
      kind: 'row',
      line,
      key: product,
      value: known,
      row: { product, category: known, cleanedName: nullIfBlank(values.cleaned_item_names) },
      rewrite: known === category ? undefined : rewriteNote('category', category, known),
    };
  });
  return collect(outcomes, 'category');
}

export function cleanEntreeClassifications(
  records: readonly CsvRecord<EntreeColumn>[],
): Cleaned<EntreeClassificationRow> {
  const outcomes = records.map(({ line, values }): Outcome<EntreeClassificationRow> => {
    const product = stripLikePython(values.product);
    if (product === '') return { kind: 'skip', line, reason: 'blank product' };
    const keyProblem = checkKey(product);
    if (keyProblem) return { kind: 'refuse', line, reason: keyProblem };

    const raw = values.entree_classification.trim();
    const classification = normalizeEntreeLabel(raw);
    if (classification === undefined) {
      return { kind: 'refuse', line, reason: `unknown classification ${JSON.stringify(raw)}` };
    }
    return {
      kind: 'row',
      line,
      key: product,
      value: classification,
      row: { product, classification, cleanedName: nullIfBlank(values.cleaned_item_names) },
      rewrite:
        classification === raw ? undefined : rewriteNote('classification', raw, classification),
    };
  });
  return collect(outcomes, 'classification');
}

export function cleanUnitWeights(
  records: readonly CsvRecord<UnitColumn>[],
): Cleaned<UnitWeightRow> {
  const outcomes = records.map(({ line, values }): Outcome<UnitWeightRow> => {
    // Verbatim, unlike a product: the lab joins on the unit exactly as an upload spells it.
    const originalUnit = values.original_unit;
    const cleanedUnit = values.llm_cleaned_unit;
    if (originalUnit.trim() === '') return { kind: 'skip', line, reason: 'blank unit' };
    if (cleanedUnit.trim() === '') return { kind: 'skip', line, reason: 'blank cleaned unit' };
    const keyProblem = checkKey(originalUnit);
    if (keyProblem) return { kind: 'refuse', line, reason: keyProblem };

    const extractedWeight = parseWeight(values.llm_extracted_weight);
    if (extractedWeight === 'invalid') {
      const reason = `weight ${JSON.stringify(values.llm_extracted_weight)} is not a positive number`;
      return { kind: 'refuse', line, reason };
    }
    return {
      kind: 'row',
      line,
      key: originalUnit,
      value: `${extractedWeight} ${cleanedUnit}`,
      row: {
        originalUnit,
        cleanedUnit,
        extractedWeight,
        exampleProducts: nullIfBlank(values.example_products),
      },
    };
  });
  return collect(outcomes, 'weight');
}

type Outcome<Row> =
  | {
      kind: 'row';
      line: number;
      key: string;
      /** What two rows of one key must agree on to be a harmless repeat. */
      value: string;
      row: Row;
      rewrite?: string | undefined;
    }
  | { kind: 'skip' | 'refuse'; line: number; reason: string };

/** Keep the last row of each key, as `CategorizationCache.from_frame` does. */
function collect<Row>(outcomes: readonly Outcome<Row>[], valueName: string): Cleaned<Row> {
  const notes = (kind: 'skip' | 'refuse') =>
    outcomes.flatMap((outcome) =>
      outcome.kind === kind ? [{ line: outcome.line, reason: outcome.reason }] : [],
    );
  const candidates = outcomes.flatMap((outcome) => (outcome.kind === 'row' ? [outcome] : []));

  const latest = new Map<string, (typeof candidates)[number]>();
  const repeats: Note[] = [];
  for (const candidate of candidates.toReversed()) {
    const later = latest.get(candidate.key);
    if (later === undefined) {
      latest.set(candidate.key, candidate);
    } else {
      const same = later.value === candidate.value ? 'the same' : 'a different';
      repeats.push({ line: candidate.line, reason: `repeated later with ${same} ${valueName}` });
    }
  }
  const kept = [...latest.values()].toReversed();

  return {
    rows: kept.map((candidate) => candidate.row),
    skipped: [...notes('skip'), ...repeats].toSorted((a, b) => a.line - b.line),
    rewritten: kept.flatMap(({ line, rewrite }) => (rewrite ? [{ line, reason: rewrite }] : [])),
    refused: notes('refuse'),
  };
}

function checkKey(key: string): string | undefined {
  const bytes = Buffer.byteLength(key, 'utf8');
  return bytes > MAX_CACHE_KEY_BYTES
    ? `key of ${bytes} bytes, over the ${MAX_CACHE_KEY_BYTES}-byte limit`
    : undefined;
}

/** Python's `str.strip`, which the pipeline applies to an upload's products before matching them
 * against the cache. JavaScript's `trim` differs at the edges: it keeps U+001C–U+001F and U+0085,
 * and strips U+FEFF. */
function stripLikePython(value: string): string {
  return value.replace(PYTHON_EDGE_WHITESPACE, '');
}

/** Every character for which Python's `str.isspace` is true. */
const PYTHON_WHITESPACE = String.raw`[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const PYTHON_EDGE_WHITESPACE = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, 'g');

function nullIfBlank(value: string): string | null {
  return value.trim() === '' ? null : value;
}

function rewriteNote(column: string, from: string, to: string): string {
  return `${column} ${JSON.stringify(from)} imported as ${JSON.stringify(to)}`;
}

/** pandas writes a missing weight as an empty field. */
function parseWeight(raw: string): number | null | 'invalid' {
  if (raw.trim() === '') return null;
  const weight = Number(raw);
  return Number.isFinite(weight) && weight > 0 ? weight : 'invalid';
}

const SIDE_ADD_ON_SPELLINGS = new Set([
  'sideaddon',
  'side',
  'addon',
  'addononly',
  'addonitem',
  'notentree',
  'notanentree',
]);

/** The lab's `_normalize_entree_classification`, without `unsure`, which the table cannot hold.
 * Its stripping of quotes and trailing periods is subsumed by dropping every non-letter. */
function normalizeEntreeLabel(raw: string): EntreeClassificationLabel | undefined {
  const compact = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'entree') return 'entree';
  if (SIDE_ADD_ON_SPELLINGS.has(compact)) return 'side/add-on';
  return undefined;
}
