<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import * as Field from '#lib/components/ui/field/index.js';
import type { PageProps } from './$types';
import DeleteButton from './delete-button.svelte';
import RenameForm from './rename-form.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Settings', data.organization.name)}</title>
</svelte:head>

<PageHeading>Settings</PageHeading>

<div class="flex w-full max-w-md flex-col gap-4">
  <RenameForm organizationSlug={data.organization.slug} initialName={data.organization.name} />

  <Field.Separator />

  <DeleteButton
    organizationSlug={data.organization.slug}
    organizationName={data.organization.name}
  />
</div>
