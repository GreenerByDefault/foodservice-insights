<script lang="ts">
import CheckIcon from '@lucide/svelte/icons/check';
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
import PlusIcon from '@lucide/svelte/icons/plus';
import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { organizationHref } from '$lib/hrefs';
import { cnChildProps } from '$lib/utils/shadcn.js';

type SwitcherOrganization = { id: string; name: string };

interface Props {
  current?: SwitcherOrganization;
  organizations: readonly SwitcherOrganization[];
  hasMore: boolean;
}

let { current, organizations, hasMore }: Props = $props();

// Matches `_SWITCHER_LIMIT` in `+layout.server.ts` — duplicated, not imported, because that file
// is server-only and this component ships to the browser. This is the row count's last word: the
// server already caps `organizations` to the same number, but `current` can arrive as an extra
// row on top of it (see below), so this is what keeps the menu itself at eight no matter which
// side contributed the organization that put it over.
const DISPLAY_LIMIT = 8;

// Current first, always — even when it sorts past the cap and so is not itself in `organizations`
// — then everyone else alphabetically. One rule, true whether or not `organizations` already
// contains `current`, so there is no merge-and-resort special case to get wrong. `rest` is
// trimmed to leave room for `current` precisely when `current` isn't already one of its rows.
const rest = $derived(
  organizations
    .filter((organization) => organization.id !== current?.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, current ? DISPLAY_LIMIT - 1 : DISPLAY_LIMIT),
);
const menuOrganizations = $derived(current ? [current, ...rest] : rest);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" class="min-w-0 max-w-full justify-between gap-1.5">
        <span class="truncate">{current?.name ?? 'Choose an organization'}</span>
        <span class="sr-only">Switch organization</span>
        <ChevronsUpDownIcon class="shrink-0 opacity-60" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>

  <DropdownMenu.Content class="max-h-(--bits-floating-available-height) w-72 overflow-y-auto p-2">
    {#each menuOrganizations as organization (organization.id)}
      <DropdownMenu.Item class="px-3 py-2">
        {#snippet child({ props })}
          <a
            {...props}
            href={organizationHref(organization.id)}
            class={cnChildProps(props, 'flex items-center gap-2')}
          >
            <CheckIcon
              class={['size-4 shrink-0', organization.id !== current?.id && 'invisible']}
            />
            <span class="truncate">{organization.name}</span>
          </a>
        {/snippet}
      </DropdownMenu.Item>
    {/each}

    <DropdownMenu.Separator class="my-2" />

    <DropdownMenu.Item class="px-3 py-2">
      {#snippet child({ props })}
        <a {...props} href="/orgs/new" class={cnChildProps(props, 'flex items-center gap-2')}>
          <PlusIcon class="size-4 shrink-0" />
          New organization
        </a>
      {/snippet}
    </DropdownMenu.Item>

    {#if hasMore}
      <DropdownMenu.Item class="px-3 py-2">
        {#snippet child({ props })}
          <a {...props} href="/orgs" class={cnChildProps(props, 'flex items-center gap-2')}>
            <span class="size-4 shrink-0"></span>
            <span class="flex-1">View all organizations</span>
            <ChevronRightIcon class="size-4 shrink-0" />
          </a>
        {/snippet}
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
