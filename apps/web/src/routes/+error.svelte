<script lang="ts">
import { page } from '$app/state';
import ErrorPage from '#lib/components/error-page.svelte';
import PublicShell from '#lib/components/public-shell.svelte';
</script>

<!-- The boundary for everything outside a signed-in page: a bad URL, a failure in `handle`, and —
     because an error in a layout's `load` surfaces *above* that layout — every 401 and
     `onboarding_required` the `(app)` gate throws. Only here does the `code` matter, since only the
     gate throws `onboarding_required`. -->
<PublicShell>
  <ErrorPage status={page.status} code={page.error?.code} />
</PublicShell>
