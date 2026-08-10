<script lang="ts">
import favicon from '$lib/assets/favicon.svg';
import './layout.css';

let { children } = $props();
</script>

<!-- No chrome, deliberately: the pages above the `(app)` gate each carry their own, so that a
     stranger is never shown the signed-in header. When auth lands, this is where the browser
     Supabase client is subscribed — `onAuthStateChange` calling `invalidateAll()` is what makes a
     sign-in visible to the server loads without a page refresh. -->

<svelte:head><link rel="icon" href={favicon}></svelte:head>

{@render children()}
