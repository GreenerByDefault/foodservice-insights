<script lang="ts">
import UploadForm from './upload-form.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<h1 class="text-2xl font-semibold tracking-tight">New report</h1>
<p>Uploading to <strong>{data.organization.name}</strong>.</p>

<div class="mt-6 max-w-2xl">
  <UploadForm organizationId={data.organization.id} rateLimitWarning={data.rateLimitWarning} />
</div>
