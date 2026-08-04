// Generates `src/generated/` from a live database: run `pnpm db:gen-types` after every
// migration, and commit the result. CI regenerates and fails if the diff is non-empty.
//
// Must be `.cjs`: kanel loads its config with `require`, and this package is ESM.
//
// Reads the same env files as everything else, so `TEST_DB=1` generates from the test stack.
// Either works — the schema is identical — but the dev stack is the default.
//
// kanel warns that this is the deprecated V3 config format. Keep it anyway: kanel-kysely
// 4.0.0 still ships only the V3 `preRenderHooks`/`typeFilter` API, so V4's `generators` array
// has no way to invoke it. Migrate when kanel-kysely does.

const { loadLocalEnv, requireEnv } = require('@gbd/core/env');
const { kyselyCamelCaseHook, kyselyTypeFilter, makeKyselyHook } = require('kanel-kysely');

loadLocalEnv();

/** Rewrite `export default SomeType;` into `export type { SomeType as default };`.
 *
 * Without this, every generated file whose default export is a type alias fails to compile
 * under `verbatimModuleSyntax` with TS1284. Kanel bug:
 * https://github.com/kristiandupont/kanel/issues/436
 *
 * Files using the `export default interface Foo {}` declaration form are already valid, and
 * fall through untouched.
 */
function exportTypeAsDefault(_path, lines) {
  const lastIndex = lines.findLastIndex((line) => line.trim() !== '');
  const match = lines[lastIndex]?.match(/^export default (\w+);$/);
  if (!match) return lines;

  const name = match[1];
  const declaresType = lines.some(
    (line) => line.includes(`type ${name} =`) || line.includes(`interface ${name}`),
  );
  if (!declaresType) return lines;

  const rewritten = [...lines];
  rewritten[lastIndex] = `export type { ${name} as default };`;
  return rewritten;
}

module.exports = {
  connection: requireEnv('DB_CONNECTION_STRING'),

  // Only our own tables. Adding 'auth' here when Supabase Auth lands will pull in ~40 files
  // that churn whenever the CLI is upgraded, which is why the CLI version is pinned in CI.
  schemas: ['public'],

  outputPath: './src/generated',
  // Wiped every run, so nothing hand-written may live there. `src/schema.ts` is the
  // hand-written companion, one level up.
  preDeleteOutputFolder: true,

  // Emit Kysely's ColumnType triples, and camelCase property names to match
  // `CamelCasePlugin` on the query side.
  preRenderHooks: [makeKyselyHook(), kyselyCamelCaseHook],
  postRenderHooks: [exportTypeAsDefault],
  typeFilter: kyselyTypeFilter,
  enumStyle: 'type',
};
