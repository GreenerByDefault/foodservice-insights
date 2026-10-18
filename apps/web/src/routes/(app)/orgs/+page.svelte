<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import type { PageProps } from './$types';
import OrganizationsList from './organizations-list.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Your organizations')}</title>
</svelte:head>

<PageHeading>
  Your organizations
  {#snippet actions()}
    <Button href="/orgs/new">New organization</Button>
  {/snippet}
</PageHeading>

<OrganizationsList organizations={data.organizations} />
