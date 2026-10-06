<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import CreateOrganizationForm from './create-organization-form.svelte';
import { pageTitle } from '#lib/page-title.js';
</script>

<svelte:head>
  <title>{pageTitle('New organization')}</title>
</svelte:head>

<PageHeading>New organization</PageHeading>

<CreateOrganizationForm />
