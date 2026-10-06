<script lang="ts">
import type { Subscription } from '@supabase/supabase-js';
import { invalidateAll } from '$app/navigation';
import favicon from '#lib/assets/favicon.svg';
import { browserAuth } from '#lib/auth/browser.js';
import { refreshWhenRestoredByBack, sessionUserChanged } from '#lib/auth/follow-session.js';
import { authMode } from '#lib/auth/mode.js';
import { Toaster } from '#lib/components/ui/sonner/index.js';
import type { LayoutProps } from './$types';
import './layout.css';

let { data, children }: LayoutProps = $props();

// A signal for e2e tests that event listeners are attached — see `@gbd/browser-testing`'s
// `ensureHydrated`.
$effect(() => {
  document.body.dataset.hydrated = 'true';
});

// Keeps the page on the session the browser holds: a sign-in or sign-out, here or in another tab,
// re-runs every load, and a page restored by Back is reloaded rather than shown as it was.
// `placeholder` has no session to follow, and must not load supabase-js.
$effect(() => {
  if (authMode() !== 'supabase') return;

  let unmounted = false;
  let unsubscribe: (() => void) | undefined;
  void (async () => {
    let subscription: Subscription;
    try {
      // Async only to match the overload `BrowserAuth` picks. Not awaited: supabase-js awaits its
      // subscribers, so `signOut()` would wait on every load re-running before it returned.
      const subscribed = await browserAuth().onAuthStateChange(async (_event, session) => {
        if (sessionUserChanged(data.sessionUserId, session)) void invalidateAll();
      });
      subscription = subscribed.data.subscription;
    } catch (cause) {
      // The client could not load. This page stops following the session; the next page load
      // tries again.
      console.error('Could not follow the session', cause);
      return;
    }
    // The subscription arrives after a dynamic import, which can outlast the layout.
    if (unmounted) subscription.unsubscribe();
    else unsubscribe = () => subscription.unsubscribe();
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

<svelte:head>
  <!-- The `.ico` first, for browsers without SVG favicons; the rest prefer the SVG after it. -->
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href={favicon} type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
</svelte:head>

{@render children()}

<Toaster position="bottom-right" />
