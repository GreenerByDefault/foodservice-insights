<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import UploadForm from './upload-form.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<PageHeading>New report</PageHeading>
<p>Uploading to <strong>{data.organization.name}</strong>.</p>

<div class="mt-6 max-w-2xl">
  <UploadForm organizationId={data.organization.id} rateLimitWarning={data.rateLimitWarning} />
</div>
