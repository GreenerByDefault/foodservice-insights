<script lang="ts">
import { page } from '$app/state';
import ErrorPage from '$lib/components/error-page.svelte';
</script>

<!-- The boundary for everything outside a signed-in page: a bad URL, a failure in `handle`, and —
     because an error in a layout's `load` surfaces *above* that layout — every 401 the `(app)` gate
     throws. So it carries its own chrome, both because the root layout has none and because a
     signed-out visitor should not be shown the signed-in header. -->
<main class="mx-auto flex min-h-svh max-w-2xl flex-col justify-center p-8">
  <ErrorPage status={page.status} />
</main>
