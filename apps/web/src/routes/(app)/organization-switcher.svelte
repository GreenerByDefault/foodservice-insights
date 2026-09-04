<script lang="ts">
import { organizationHref } from '$lib/hrefs';

type SwitcherOrganization = { id: string; name: string };

interface Props {
  current?: SwitcherOrganization;
  organizations: readonly SwitcherOrganization[];
}

let { current, organizations }: Props = $props();
</script>

<details class="relative min-w-0">
  <summary class="cursor-pointer truncate font-medium">
    {current?.name ?? 'Choose an organization'}
  </summary>

  <ul class="absolute left-0 z-10 mt-2 min-w-56 rounded-md border bg-background p-1 shadow-md">
    {#each organizations as organization (organization.id)}
      <li>
        <a
          class="block rounded-sm px-2 py-1 hover:bg-muted"
          href={organizationHref(organization.id)}
        >
          {organization.name}
        </a>
      </li>
    {/each}
    <li>
      <a class="block rounded-sm px-2 py-1 hover:bg-muted" href="/orgs/new"> New organization </a>
    </li>
  </ul>
</details>
