<script lang="ts">
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import { organizationHref } from '$lib/hrefs';
import type { OrganizationListRow } from './+page.server.ts';

interface Props {
  organizations: readonly OrganizationListRow[];
}

let { organizations }: Props = $props();
</script>

{#if organizations.length === 0}
  <p class="w-full text-muted-foreground">No organizations yet.</p>
{:else}
  <ul class="w-full divide-y border-y">
    {#each organizations as organization (organization.id)}
      <li>
        <a
          href={organizationHref(organization.id)}
          class="flex w-full items-center justify-between gap-4 px-2 py-3 hover:bg-accent focus-visible:bg-accent"
        >
          <span class="min-w-0 truncate font-medium" title={organization.name}
            >{organization.name}</span
          >
          <ChevronRightIcon
            class="size-5 shrink-0 text-muted-foreground"
            strokeWidth={2.5}
            aria-hidden="true"
          />
        </a>
      </li>
    {/each}
  </ul>
{/if}
