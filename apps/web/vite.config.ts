import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Our workspace packages, which the production server resolves at runtime instead of bundling.
 *
 * Inlining them into the SSR bundle is Vite's default for linked workspace packages, and it is
 * what we are avoiding. An inlined `@gbd/db` still imports `pg` itself, and Vite resolves that
 * import from `apps/web` — so `apps/web` would have to declare `pg` despite never importing it,
 * and likewise for every dependency of every package, with nothing to catch a missing one.
 * Inlining also moves a package's code into the app's bundle, which breaks any package that
 * locates files from `import.meta.dirname`.
 *
 * Instead, the only cost of externalizing is that these packages must ship alongside the built
 * server.
 *
 * WORKSPACE_PACKAGES is derived from `dependencies` so that adding a package needs no change here.
 * `devDependencies` is deliberately not consulted: a package that isn't a runtime dependency
 * wouldn't be installed next to the built server to resolve.
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

    /** One project per thing a test can need, selected by suffix:
     *
     * - `unit` — nothing. No Docker, no browser.
     * - `integration` (`*.integration.test.ts`) — the Supabase test stack.
     * - `component` (`*.svelte.test.ts`) — a real Chromium.
     *
     * The suffix, not the directory, because the requirement doesn't follow the directory:
     * `lib/server/auth/guards.test.ts` is pure and `routes/health/` talks to both stores. And the
     * bare suffix is the *pure* one, so a mislabelled test fails loudly on a refused connection
     * rather than quietly costing everyone a container.
     */
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'component',
          browser: {
            enabled: true,
            provider: playwright({ actionTimeout: 5_000 }),
            instances: [{ browser: 'chromium', headless: true }],
          },
          include: ['src/**/*.svelte.test.ts'],
          exclude: ['src/lib/server/**'],
        },
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.svelte.test.ts', 'src/**/*.integration.test.ts'],
        },
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'integration',
          environment: 'node',
          globalSetup: ['./src/lib/server/tests/global-setup.ts'],
          include: ['src/**/*.integration.test.ts'],
        },
      },
    ],
  },
}));
