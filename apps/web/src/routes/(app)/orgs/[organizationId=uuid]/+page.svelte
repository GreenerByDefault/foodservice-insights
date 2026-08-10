<script lang="ts">
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<!-- **Stub:** the heading and the link are real; the list of reports is not built yet.
     The dashboard is the list — REQUIREMENTS.md asks for no search and no filtering. While any row
     is still queued or processing, poll with `invalidate()` roughly every ten seconds. -->
<h1 class="text-2xl font-semibold tracking-tight">{data.organization.name}</h1>

<p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>

<a class="underline hover:no-underline" href="/orgs/{data.organization.id}/reports/new">
  New report
</a>
