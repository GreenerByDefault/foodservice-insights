<script lang="ts">
import type { Snippet } from 'svelte';
import PublicHeader from './public-header.svelte';

/** The chrome for a page outside the `(app)` gate — sign-in and the root error boundary. The
 * marketing page lays out its own, around the same header. The root layout deliberately has none,
 * since a stranger is never shown the signed-in header. */
interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<div class="flex min-h-svh flex-col">
  <PublicHeader />

  <main
    class="mx-auto flex w-full max-w-4xl flex-1 flex-col items-start justify-center gap-4 px-6 py-8 sm:px-8"
  >
    {@render children()}
  </main>
</div>
