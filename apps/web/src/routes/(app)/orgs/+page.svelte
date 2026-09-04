<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import { organizationHref } from '$lib/hrefs';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<PageHeading>Choose an organization</PageHeading>

<ul class="flex flex-col gap-2">
  {#each data.organizations as organization (organization.id)}
    <li>
      <a class="underline hover:no-underline" href={organizationHref(organization.id)}>
        {organization.name}
      </a>
    </li>
  {/each}
</ul>
