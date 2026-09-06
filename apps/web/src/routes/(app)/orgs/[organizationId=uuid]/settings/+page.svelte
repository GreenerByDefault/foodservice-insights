<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import RenameForm from './rename-form.svelte';

let { data }: PageProps = $props();
</script>

<PageHeading>Settings</PageHeading>

<RenameForm organizationId={data.organization.id} initialName={data.organization.name} />
