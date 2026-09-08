<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import * as Field from '$lib/components/ui/field';
import type { PageProps } from './$types';
import DeleteButton from './delete-button.svelte';
import RenameForm from './rename-form.svelte';

let { data }: PageProps = $props();
</script>

<PageHeading>Settings</PageHeading>

<RenameForm organizationSlug={data.organization.slug} initialName={data.organization.name} />

<Field.Separator />

<DeleteButton organizationSlug={data.organization.slug} organizationName={data.organization.name} />
