<script lang="ts">
import type { Snippet } from 'svelte';

/** The chrome for a page outside the `(app)` gate — the marketing page, sign-in, and the root
 * error boundary. The root layout deliberately has none, since a stranger is never shown the
 * signed-in header. */
interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-8">
  {@render children()}
</main>
