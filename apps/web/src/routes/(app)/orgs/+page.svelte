<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import type { PageProps } from './$types';
import OrganizationsList from './organizations-list.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Organizations')}</title>
</svelte:head>

<div class="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
  <PageHeading>Organizations</PageHeading>
  <Button href="/orgs/new">New organization</Button>
</div>

<OrganizationsList organizations={data.organizations} />
