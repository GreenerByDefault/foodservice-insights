<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import { organizationHref } from '$lib/hrefs';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<!-- The picker, reached only when more than one organization is on offer; `+page.server.ts` sends
     everyone else straight on. The switcher in the header does the same job afterwards, so this
     page exists for the one moment before the user has chosen anything. -->
<PageHeading>Choose an organization</PageHeading>

<ul class="flex flex-col gap-2">
  {#each data.auth.memberships as organization (organization.organizationId)}
    <li>
      <a class="underline hover:no-underline" href={organizationHref(organization.organizationId)}>
        {organization.organizationName}
      </a>
    </li>
  {/each}
</ul>
