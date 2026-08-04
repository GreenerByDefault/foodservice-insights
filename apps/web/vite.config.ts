import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// `.env` files live at the repo root, not in this package. Vite and SvelteKit each need
// telling separately: `envDir` covers Vite, and `env.dir` covers `$env/*`, which otherwise
// defaults to this directory and silently resolves to nothing.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  envDir: REPO_ROOT,
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
  ssr: {
    // Node can't load .ts from node_modules; keep this even if pnpm's auto-inlining changes.
    noExternal: [/^@gbd\//],
  },
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
          // Migrates the test database. `TEST_DB=1` in the `test:unit` script is what points
          // this — and `$env/dynamic/private`, via Vite's test mode — at the test stack.
          globalSetup: ['./src/lib/server/tests/global-setup.ts'],
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
});
