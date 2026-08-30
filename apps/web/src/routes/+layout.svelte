<script lang="ts">
import type { Snippet } from 'svelte';
import favicon from '$lib/assets/favicon.svg';
import './layout.css';

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

// A signal for e2e tests that event listeners are attached — see `apps/web/e2e/lib/hydration.ts`.
$effect(() => {
  document.body.dataset.hydrated = 'true';
});
</script>

<!-- No chrome, deliberately: the pages above the `(app)` gate each carry their own, so that a
     stranger is never shown the signed-in header. When auth lands, this is where the browser
     Supabase client is subscribed — `onAuthStateChange` calling `invalidateAll()` is what makes a
     sign-in visible to the server loads without a page refresh. -->

<svelte:head><link rel="icon" href={favicon}></svelte:head>

{@render children()}
