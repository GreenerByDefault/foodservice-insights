<script lang="ts">
import ItemList from '$lib/components/item-list.svelte';
import ItemListLink from '$lib/components/item-list-link.svelte';
import { organizationHref } from '$lib/hrefs';
import type { OrganizationListRow } from './+page.server.ts';

interface Props {
  organizations: readonly OrganizationListRow[];
}

let { organizations }: Props = $props();
</script>

<ItemList
  items={organizations}
  key={(organization) => organization.id}
  empty="No organizations yet."
>
  {#snippet children(organization)}
    <ItemListLink href={organizationHref(organization.id)}>
      <span class="min-w-0 truncate font-medium" title={organization.name}
        >{organization.name}</span
      >
    </ItemListLink>
  {/snippet}
</ItemList>
