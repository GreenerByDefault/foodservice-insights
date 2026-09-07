<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import * as Field from '$lib/components/ui/field';
import type { PageProps } from './$types';
import DeleteButton from './delete-button.svelte';
import RenameForm from './rename-form.svelte';

let { data }: PageProps = $props();
</script>

<PageHeading>Settings</PageHeading>

<RenameForm organizationId={data.organization.id} initialName={data.organization.name} />

<Field.Separator />

<DeleteButton organizationId={data.organization.id} organizationName={data.organization.name} />
