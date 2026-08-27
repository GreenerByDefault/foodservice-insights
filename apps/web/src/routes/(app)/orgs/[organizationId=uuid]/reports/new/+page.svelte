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
     Posts to `POST /api/orgs/[organizationId]/reports`, which answers 201 and a location.

     `data.rateLimitWarning`, when set, is the one sentence `describeRateLimitExceeded` produced —
     render it in an `Alert` above the drop zone, non-blocking (the form, drop zone, and submit
     button all stay enabled). Show it only when set: no "N of 5 used this hour" counters, ever —
     that's four independent numbers (org/user × hourly/weekly) a non-technical user has no use
     for until one of them actually stops an upload. See .claude/plans/report-upload-form.md's PR 2 section. -->
<h1 class="text-2xl font-semibold tracking-tight">New report</h1>

<!-- REQUIREMENTS.md asks that the organization a report will belong to be unmistakable here,
     because a report cannot be moved afterwards. -->
<p>Uploading to <strong>{data.organization.name}</strong>.</p>

<p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>
