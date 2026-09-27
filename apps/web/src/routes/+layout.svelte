<script lang="ts">
import type { Snippet } from 'svelte';
import { invalidateAll } from '$app/navigation';
import favicon from '$lib/assets/favicon.svg';
import { browserAuth } from '$lib/auth/browser';
import { refreshWhenRestoredByBack, shouldInvalidate } from '$lib/auth/follow-session';
import { authMode } from '$lib/auth/mode';
import './layout.css';

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

// A signal for e2e tests that event listeners are attached — see `@gbd/browser-testing`'s
// `ensureHydrated`.
$effect(() => {
  document.body.dataset.hydrated = 'true';
});

// Keeps the page on the session the browser holds: a sign-in or sign-out re-runs every load, and a
// page restored by Back is reloaded rather than shown as it was. `placeholder` has no session to
// follow, and must not load supabase-js.
$effect(() => {
  if (authMode() !== 'supabase') return;

  let unmounted = false;
  let unsubscribe: (() => void) | undefined;
  void (async () => {
    // Async only to match the overload `BrowserAuth` picks. Not awaited: supabase-js awaits its
    // subscribers, so `signOut()` would wait on every load re-running before it returned.
    const { data } = await browserAuth().onAuthStateChange(async (event) => {
      if (shouldInvalidate(event)) void invalidateAll();
    });
    // The subscription arrives after a dynamic import, which can outlast the layout.
    if (unmounted) data.subscription.unsubscribe();
    else unsubscribe = () => data.subscription.unsubscribe();
  })();

  const onPageShow = refreshWhenRestoredByBack(() => location.reload());
  window.addEventListener('pageshow', onPageShow);

  return () => {
    unmounted = true;
    unsubscribe?.();
    window.removeEventListener('pageshow', onPageShow);
  };
});
</script>

<!-- No chrome, deliberately: the pages above the `(app)` gate each carry their own, so that a
     stranger is never shown the signed-in header. -->

<svelte:head><link rel="icon" href={favicon}></svelte:head>

{@render children()}
