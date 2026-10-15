// Must be `.cjs`: kanel loads its config with `require`, and this package is ESM.
//
// Reads the same env files as everything else, so `TEST_DB=1` generates from the test stack
// instead of the default dev stack.
//
// kanel warns that this is the deprecated V3 config format. Keep it anyway: kanel-kysely
// 4.0.0 still ships only the V3 `preRenderHooks`/`typeFilter` API, so V4's `generators` array
// has no way to invoke it. Migrate when kanel-kysely does. The same holds for
// `defaultGetPropertyMetadata`, deprecated with the V3 format: V4 hands the default to
// `getPropertyMetadata` as an argument, which Kanel's V3 wrapper drops.

const { loadLocalEnv, requireEnv } = require('@gbd/core/env');
const { join } = require('node:path');
const { defaultGetPropertyMetadata } = require('kanel');
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

const OUTPUT_PATH = './src/generated';

/** A type exported from another generated file, such as `public/Report`. */
function generatedType(file, name, isDefault) {
  return {
    name,
    typeImports: [
      {
        name,
        path: join(OUTPUT_PATH, file),
        isAbsolute: false,
        isDefault,
        importAsType: true,
      },
    ],
  };
}

const ATTEMPT_ID = generatedType('public/AnalysisAttempt', 'AnalysisAttemptId', false);
const ORGANIZATION_ID = generatedType('public/Organization', 'OrganizationId', false);

/** Kanel types an id column from its foreign key, and brands a primary-key column with none as an
 * id of its own table. Tables that outlive what they name keep its ids raw, with no foreign key, so
 * Kanel gets both wrong: a raw id comes out a plain `string`, and a raw id or enum in a primary key
 * comes out a brand of its own. Each such column gets the type it actually holds. */
const TYPE_OVERRIDES = {
  audit_event: {
    actor_user_id: generatedType('auth/Users', 'UsersId', false),
    organization_id: ORGANIZATION_ID,
  },
  analysis_attempt_telemetry: {
    analysis_attempt_id: ATTEMPT_ID,
    report_id: generatedType('public/Report', 'ReportId', false),
    organization_id: ORGANIZATION_ID,
  },
  analysis_attempt_llm_usage: {
    analysis_attempt_id: ATTEMPT_ID,
    operation: generatedType('public/LlmOperation', 'LlmOperation', true),
    requested_model: 'string',
  },
  analysis_attempt_quality_check: {
    analysis_attempt_id: ATTEMPT_ID,
    quality_check: generatedType('public/QualityCheck', 'QualityCheck', true),
    status: generatedType('public/DiagnosticStatus', 'DiagnosticStatus', true),
  },
};

function getPropertyMetadata(property, details, generateFor, instantiatedConfig) {
  const metadata = defaultGetPropertyMetadata(property, details, generateFor, instantiatedConfig);
  const typeOverride =
    details.schemaName === 'public' ? TYPE_OVERRIDES[details.name]?.[property.name] : undefined;
  return typeOverride === undefined ? metadata : { ...metadata, typeOverride };
}

module.exports = {
  connection: requireEnv('DB_CONNECTION_STRING'),

  schemas: ['public', 'auth'],

  outputPath: OUTPUT_PATH,

  getPropertyMetadata,

  // Emit `.ts` files whose relative imports carry a `.js` extension so that
  // imports from the rest of the monorepo work.
  tsModuleFormat: 'esm',

  // Wipe our schema every run so that nothing hand-written can sneak in.
  preDeleteOutputFolder: true,

  preRenderHooks: [makeKyselyHook(), kyselyCamelCaseHook],
  postRenderHooks: [exportTypeAsDefault],

  typeFilter: (type) =>
    kyselyTypeFilter(type) && type.kind !== 'function' && type.kind !== 'procedure',

  enumStyle: 'type',
};
