<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import { organizationHref } from '$lib/hrefs';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<!-- The full picker: everyone with more than one organization on offer lands here at sign-in
     (`+page.server.ts` sends everyone else straight on), and it is also where the switcher's
     "View all organizations" row goes once the menu is over the cap. Unlike the switcher, this
     list is never capped. -->
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
