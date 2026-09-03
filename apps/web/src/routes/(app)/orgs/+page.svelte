<script lang="ts">
import { organizationHref } from '$lib/hrefs';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<!-- The picker, reached only when more than one organization is on offer; `+page.server.ts` sends
     everyone else straight on. The switcher in the header does the same job afterwards, so this
     page exists for the one moment before the user has chosen anything. -->
<h1 class="text-2xl font-semibold tracking-tight">Choose an organization</h1>

<ul class="flex flex-col gap-2">
  {#each data.auth.organizations as organization (organization.organizationId)}
    <li>
      <a class="underline hover:no-underline" href={organizationHref(organization.organizationId)}>
        {organization.organizationName}
      </a>
    </li>
  {/each}
</ul>
