import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // One .env at the repo root, shared by the web app, the worker, and scripts.
  // Vite would otherwise only look inside apps/web.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    tailwindcss(),
    // SvelteKit config lives here rather than in svelte.config.js, which is
    // soft-deprecated. Note that svelte-check does NOT read this file, so
    // anything under compilerOptions is invisible to `pnpm check`.
    sveltekit({
      compilerOptions: {
        // Force runes mode for our own code, but not for libraries.
        // Can be removed in Svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true
      },
      adapter: adapter()
    })
  ],
  ssr: {
    // Vite already inlines pnpm-symlinked workspace packages, because their real
    // path resolves outside node_modules. Stating it explicitly keeps @gbd/*
    // bundled if that ever stops being true (`pnpm deploy`, a hoisted
    // node-linker, Docker) -- Node cannot load TypeScript from node_modules.
    noExternal: [/^@gbd\//]
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
            instances: [{ browser: 'chromium', headless: true }]
          },
          include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
          exclude: ['src/lib/server/**']
        }
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
        }
      }
    ]
  }
});
