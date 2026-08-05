// Must be `.cjs`: kanel loads its config with `require`, and this package is ESM.
//
// Reads the same env files as everything else, so `TEST_DB=1` generates from the test stack
// instead of the default dev stack.
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

  schemas: ['public', 'auth'],

  outputPath: './src/generated',

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
