import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Our workspace packages, which the production server resolves at runtime, unbundled.
 *
 * Vite inlines linked workspace packages into the SSR bundle by default, but leaves their
 * *dependencies* external and resolves those from `apps/web` — so `@gbd/db` gets inlined
 * while its `pg` import stays a bare specifier that only `apps/web/node_modules` can
 * satisfy. Under pnpm's isolated layout, it can't, and the failure would be at production startup
 * rather than at build time. Bundling also breaks any package that resolves paths relative
 * to its own location, since inlining moves it. Keeping them external lets each package own
 * its dependencies, at the cost of having to ship the packages alongside the built server.
 *
 * Derived from `dependencies` rather than written out, so adding a package is enough.
 * `devDependencies` is deliberately not consulted: a package that isn't a runtime
 * dependency wouldn't be installed alongside the built server to resolve.
 */
const WORKSPACE_PACKAGES = Object.keys(pkg.dependencies).filter((name) => name.startsWith('@gbd/'));

export default defineConfig(({ command }) => ({
  envDir: REPO_ROOT,

  // Build only: in dev, an external module is loaded by native `import` and cached for the
  // life of the process, so package edits would never reach the running server.
  ssr: { external: command === 'build' ? WORKSPACE_PACKAGES : [] },

  plugins: [
    tailwindcss(),
    sveltekit({
      env: { dir: REPO_ROOT },
      compilerOptions: {
        // Runes mode for our code only, not libraries. Removable in Svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      adapter: adapter(),
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'client',
          browser: {
            enabled: true,
            provider: playwright({ actionTimeout: 5_000 }),
            instances: [{ browser: 'chromium', headless: true }],
          },
          include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
          exclude: ['src/lib/server/**'],
        },
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          globalSetup: ['./src/lib/server/tests/global-setup.ts'],
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
}));
