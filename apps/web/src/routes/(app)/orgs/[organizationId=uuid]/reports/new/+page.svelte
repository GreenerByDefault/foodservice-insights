<script lang="ts">
import type { CountDraft } from '$lib/reports/monthly-counts';
import MonthlyCounts from './monthly-counts.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

// **Temporary, dev-only preview of PR 1's `monthly-counts.svelte`** — there is nowhere else to
// see it rendered until PR 2 wires up the real upload form. Delete this block (down to
// `<!-- /preview -->`) when that lands; it is not meant to survive review.
let previewCounts: CountDraft = $state({});
</script>

<!-- **Stub:** names the organization for real; the upload form itself is not built yet.
     It takes one file at a time, plus the metadata a run needs: monthly diner or meal counts, an
     optional site name, lb or kg, and a name for the report.
     XLSX is converted to CSV here, in the browser, because the server accepts only CSV — and the
     conversion has to be careful with how Excel stores dates. A structural check on the header is
     worth doing here for the feedback, but it proves nothing: the server validates in full.
     Posts to `POST /api/orgs/[organizationId]/reports`, which answers 201 and a location. -->
<h1 class="text-2xl font-semibold tracking-tight">New report</h1>

<!-- REQUIREMENTS.md asks that the organization a report will belong to be unmistakable here,
     because a report cannot be moved afterwards. -->
<p>Uploading to <strong>{data.organization.name}</strong>.</p>

<p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>

<!-- preview -->
<div class="mt-8 max-w-2xl rounded-md border border-dashed p-4">
  <p class="mb-4 text-sm text-muted-foreground">
    Dev preview of <code>monthly-counts.svelte</code>, spanning two years. Removed in PR 2.
  </p>
  <MonthlyCounts
    months={['2025-11', '2025-12', '2026-01', '2026-02']}
    basis="people"
    bind:counts={previewCounts}
  />
</div>
<!-- /preview -->
