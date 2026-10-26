import { type CreateTableBuilder, type Kysely, sql } from 'kysely';
import { updatedAtTrigger, verifiedAtTrigger } from './_shared.ts';

// The caches the categorization pipeline and the lab look answers up in before asking an LLM.
// Each table is its own review queue: anything a run or the lab suggests lands unverified, and
// is used by nobody until a human verifies it in Supabase Studio.
//
// No foreign keys, to reports or anything else: a verified answer must outlive the report whose
// run suggested it, so `suggested_by` names that attempt as text.

export async function up(database: Kysely<any>): Promise<void> {
  await functions(database);
  await cacheClientRole(database);
  await productCategorization(database);
  await entreeClassification(database);
  await unitWeight(database);
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

async function functions(database: Kysely<any>): Promise<void> {
  // A reviewer only ticks `is_verified`; `verified_at` follows it and ignores any value typed
  // into it. `verifiedAtTrigger` in `_shared.ts` attaches this to a table.
  await sql`
    CREATE FUNCTION set_verified_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
        NEW.verified_at := CASE WHEN NEW.is_verified THEN now() END;
      ELSE
        NEW.verified_at := OLD.verified_at;
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(database);
}

// ---------------------------------------------------------------------------
// cache_client
// ---------------------------------------------------------------------------

async function cacheClientRole(database: Kysely<any>): Promise<void> {
  // A role is cluster-wide, and the local test stack migrates several databases in one cluster
  // at once. The loser of a race on CREATE ROLE waits on the winner's uncommitted row, then fails
  // with unique_violation rather than duplicate_object, so the block catches both. Everything
  // else that writes the role's own catalog row is in here too, so only the winner writes it:
  // two concurrent writes to one shared row fail with "tuple concurrently updated".
  //
  // On Postgres 16+, creating a role grants its creator ADMIN on it but not SET, so the grant to
  // CURRENT_USER is what lets `postgres` run `SET ROLE cache_client` to test the grants below.
  // INHERIT FALSE, so it gains no privileges from it.
  //
  // The settings are defaults a client could override; they stop a forgotten session, not a
  // hostile one. An idle transaction holding an uncommitted suggestion would otherwise block every
  // other insert of the same key, including a production run's. An idle session, such as a
  // notebook kernel left open, would otherwise hold one of the role's connections indefinitely.
  //
  // No password: it is set by hand on the hosted project, and the local stacks never log in as
  // this role. Everyone who reaches the caches shares it, so revoking one person means a new
  // password for the rest. *Rejected: a role per person.* That cost is acceptable for a role
  // that can only read two tables and suggest rows.
  await sql`
    DO $$ BEGIN
      CREATE ROLE cache_client LOGIN NOINHERIT CONNECTION LIMIT 10;
      ALTER ROLE cache_client SET statement_timeout = '30s';
      ALTER ROLE cache_client SET idle_in_transaction_session_timeout = '60s';
      ALTER ROLE cache_client SET idle_session_timeout = '10min';
      GRANT cache_client TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
      COMMENT ON ROLE cache_client IS
        'The lab and developers'' local workers: reads the cache tables and inserts unverified suggestions into them.';
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END $$
  `.execute(database);
}

/** SELECT, and INSERT on only the columns a suggestion names, so every row the role writes
 * lands unverified with the table's own id and timestamps. Named rather than "all but the review
 * columns", so a column a later migration adds is not writable until someone decides it should
 * be. */
async function grantToCacheClient(
  database: Kysely<any>,
  table: string,
  insertableColumns: readonly string[],
): Promise<void> {
  await sql`GRANT SELECT ON ${sql.table(table)} TO cache_client`.execute(database);
  await sql`
    GRANT INSERT (${sql.join(insertableColumns.map((column) => sql.ref(column)))})
      ON ${sql.table(table)} TO cache_client
  `.execute(database);
}

// ---------------------------------------------------------------------------
// Shared shape
// ---------------------------------------------------------------------------

/** The review columns every cache table carries. Studio's grid can only edit a table with a
 * primary key, which is the only reason these tables have a surrogate one. */
function reviewColumns(
  builder: CreateTableBuilder<string, any>,
  table: string,
): CreateTableBuilder<string, any> {
  return builder
    .addColumn('is_verified', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('verified_at', 'timestamptz')
    .addColumn('suggested_by', 'text', (column) => column.notNull().defaultTo('manual'))
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(`${table}_suggested_by_not_blank`, sql`suggested_by ~ '[^[:space:]]'`);
}

/** The pipeline matches an upload's products exactly, after stripping them, so a product with
 * surrounding whitespace could never be hit. `[[:space:]]` rather than `btrim`, which strips
 * only spaces, to agree with Python's `str.strip`.
 *
 * The byte bound keeps the unique index's entry inside the b-tree's limit of about 2,700 bytes.
 * Not imported from MAX_CACHE_KEY_BYTES (constraints.ts), so a later change to the constant cannot
 * silently disagree with an applied constraint; caches.test.ts pins the two together. */
function productKey(
  builder: CreateTableBuilder<string, any>,
  table: string,
): CreateTableBuilder<string, any> {
  return builder
    .addColumn('product', 'text', (column) => column.notNull())
    .addUniqueConstraint(`${table}_product_key`, ['product'])
    .addCheckConstraint(`${table}_product_trimmed`, sql`product !~ '^[[:space:]]|[[:space:]]$'`)
    .addCheckConstraint(`${table}_product_length`, sql`octet_length(product) BETWEEN 1 AND 2000`);
}

async function commentOnCacheTable(database: Kysely<any>, table: string): Promise<void> {
  await sql`
    COMMENT ON TABLE ${sql.table(table)} IS
      'Only verified rows are ever used. The app and the lab insert suggestions unverified; a human corrects the value here if needed and ticks is_verified.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN ${sql.raw(`${table}.verified_at`)} IS
      'Maintained by a trigger from is_verified. A value typed here is ignored.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN ${sql.raw(`${table}.suggested_by`)} IS
      'Where the row came from: attempt:<id> from a worker run, lab:<user>, import:<file>, or manual.'
  `.execute(database);
}

async function reviewTriggers(database: Kysely<any>, table: string): Promise<void> {
  await verifiedAtTrigger(database, table);
  await updatedAtTrigger(database, table);
}

// ---------------------------------------------------------------------------
// product_categorization
// ---------------------------------------------------------------------------

async function productCategorization(database: Kysely<any>): Promise<void> {
  await database.schema
    .createTable('product_categorization')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .$call((builder) => productKey(builder, 'product_categorization'))
    // Text, not an enum: the categories are the analysis library's YAML, which changes without a
    // migration, and the child already drops a row whose category is not in it, with a WARNING.
    // Trimmed for the same reason as `product`: the YAML is matched exactly.
    .addColumn('category', 'text', (column) => column.notNull())
    .addColumn('cleaned_name', 'text')
    .$call((builder) => reviewColumns(builder, 'product_categorization'))
    .addCheckConstraint(
      'product_categorization_category_trimmed_not_empty',
      sql`category !~ '^[[:space:]]|[[:space:]]$' AND category <> ''`,
    )
    .addCheckConstraint(
      'product_categorization_cleaned_name_not_blank',
      sql`cleaned_name IS NULL OR cleaned_name ~ '[^[:space:]]'`,
    )
    .execute();

  await commentOnCacheTable(database, 'product_categorization');
  await sql`
    COMMENT ON COLUMN product_categorization.category IS
      'A category from GBD_categories.yaml, or No Matches Found. A row whose category is not in the YAML is skipped by every run, with a warning.'
  `.execute(database);
  await reviewTriggers(database, 'product_categorization');
  await grantToCacheClient(database, 'product_categorization', [
    'product',
    'category',
    'cleaned_name',
    'suggested_by',
  ]);
}

// ---------------------------------------------------------------------------
// entree_classification
// ---------------------------------------------------------------------------

async function entreeClassification(database: Kysely<any>): Promise<void> {
  await database.schema
    .createType('entree_classification_label')
    .asEnum(['entree', 'side/add-on'])
    .execute();

  await database.schema
    .createTable('entree_classification')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .$call((builder) => productKey(builder, 'entree_classification'))
    .addColumn('classification', sql`entree_classification_label`, (column) => column.notNull())
    .addColumn('cleaned_name', 'text')
    .$call((builder) => reviewColumns(builder, 'entree_classification'))
    .addCheckConstraint(
      'entree_classification_cleaned_name_not_blank',
      sql`cleaned_name IS NULL OR cleaned_name ~ '[^[:space:]]'`,
    )
    .execute();

  await commentOnCacheTable(database, 'entree_classification');
  await reviewTriggers(database, 'entree_classification');
  await grantToCacheClient(database, 'entree_classification', [
    'product',
    'classification',
    'cleaned_name',
    'suggested_by',
  ]);
}

// ---------------------------------------------------------------------------
// unit_weight
// ---------------------------------------------------------------------------

async function unitWeight(database: Kysely<any>): Promise<void> {
  await database.schema
    .createTable('unit_weight')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    // Verbatim, unlike `product`: the lab joins on the unit exactly as the upload spells it, and
    // GBD's file holds units that differ only by surrounding whitespace.
    .addColumn('original_unit', 'text', (column) => column.notNull())
    .addColumn('cleaned_unit', 'text', (column) => column.notNull())
    // Null when the extraction failed; a verified null says "do not ask again".
    .addColumn('extracted_weight', 'double precision')
    .addColumn('example_products', 'text')
    .$call((builder) => reviewColumns(builder, 'unit_weight'))
    .addUniqueConstraint('unit_weight_original_unit_key', ['original_unit'])
    .addCheckConstraint('unit_weight_original_unit_not_blank', sql`original_unit ~ '[^[:space:]]'`)
    // Mirrors MAX_CACHE_KEY_BYTES, like the product key's bound.
    .addCheckConstraint(
      'unit_weight_original_unit_length',
      sql`octet_length(original_unit) <= 2000`,
    )
    .addCheckConstraint('unit_weight_cleaned_unit_not_blank', sql`cleaned_unit ~ '[^[:space:]]'`)
    // NaN compares greater than every number in Postgres, so `> 0` alone would admit it, and
    // pandas hands over a missing weight as NaN.
    .addCheckConstraint(
      'unit_weight_extracted_weight_positive_finite',
      sql`extracted_weight IS NULL OR (extracted_weight > 0 AND extracted_weight < 'Infinity')`,
    )
    .addCheckConstraint(
      'unit_weight_example_products_not_blank',
      sql`example_products IS NULL OR example_products ~ '[^[:space:]]'`,
    )
    .execute();

  await commentOnCacheTable(database, 'unit_weight');
  await reviewTriggers(database, 'unit_weight');
  await grantToCacheClient(database, 'unit_weight', [
    'original_unit',
    'cleaned_unit',
    'extracted_weight',
    'example_products',
    'suggested_by',
  ]);
}
