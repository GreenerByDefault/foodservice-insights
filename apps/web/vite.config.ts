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
      // Sent on rendered pages only. `handle` adds the Supabase origin to `connect-src` at runtime,
      // so one image serves every environment: `#lib/server/security-headers.ts`.
      csp: {
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          // bits-ui writes `style` attributes, during SSR and through `setAttribute`, and neither
          // can carry a nonce. `script-src` is what protects the session cookie.
          'style-src': ['self', 'unsafe-inline'],
          // Vite inlines `favicon.svg` as a `data:` URI.
          'img-src': ['self', 'data:'],
          'connect-src': ['self'],
          // fflate unzips a workbook entry of 512 KiB or more in a `blob:` worker.
          'worker-src': ['blob:'],
          'object-src': ['none'],
          'base-uri': ['none'],
          'form-action': ['self'],
          'frame-ancestors': ['none'],
          // Both, since Firefox and Safari read only `report-uri`. `csp` names the endpoint in
          // `Reporting-Endpoints`, set beside this policy in `handle`. Chromium sends `report-to`
          // reports only from an `https:` page, so under `pnpm dev` it reports nothing; its
          // console still shows the violation.
          'report-uri': ['/csp-report'],
          'report-to': ['csp'],
        },
      },
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    // Only print logs for tests that fail.
    silent: 'passed-only',
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'client',
          // Rendered without Tailwind's CSS, so `hidden`, `sr-only` and every focus ring are inert
          // here, and Chromium forwards `label.focus()` to its control: whether something is
          // focusable, or visibly focused, can only be proven in Playwright.
          //
          // This tier's wall clock says little about the tests: startup is ~1.5s and the tests
          // ~10s, but `chrome-headless-shell` then takes 1.5s to Playwright's 30s force-kill cap
          // to exit, which is the whole of the variance. A bare launch-then-close, no page ever
          // loaded, reproduces it, so little here — file count, `isolate`, flags — moves it.
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
          globalSetup: ['./src/lib/server/testing/global-setup.ts'],
          setupFiles: ['./src/lib/server/testing/setup-file.ts'],
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],

          // Supabase Storage can have contention.
          testTimeout: 30_000,
        },
      },
    ],
  },
}));
