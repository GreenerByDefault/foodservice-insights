<script lang="ts">
import type { PageProps } from './$types';

let { data }: PageProps = $props();
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
