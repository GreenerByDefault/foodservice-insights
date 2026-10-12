<script lang="ts">
import type { OrganizationRole } from '@gbd/db';
import { invalidate } from '$app/navigation';
import ItemList from '#lib/components/item-list.svelte';
import ItemListRow from '#lib/components/item-list-row.svelte';
import MemberActions from './member-actions.svelte';
import type { MemberRow } from './+page.server.ts';
import { MEMBERS_DEPENDENCY } from './dependencies.ts';

interface Props {
  members: readonly MemberRow[];
  organizationSlug: string;
  viewerRole: OrganizationRole;
}

let { members, organizationSlug, viewerRole }: Props = $props();

const ROLE_LABEL = { admin: 'Admin', member: 'Member' } as const;
</script>

<!-- No empty state: `organization_check_has_member` makes an empty list impossible. -->
<ItemList items={members} key={(member) => member.userId} empty="">
  {#snippet children(
    member,
  )}
    <ItemListRow>
      <span class="flex min-w-0 flex-col">
        <span class="min-w-0 truncate font-medium">
          {member.displayName ?? member.email}
          {#if member.isYou}
            <span class="text-muted-foreground">(You)</span>
          {/if}
        </span>
        {#if member.displayName}
          <span class="truncate text-sm text-muted-foreground">{member.email}</span>
        {/if}
      </span>
      <span class="shrink-0 text-sm text-muted-foreground">{ROLE_LABEL[member.role]}</span>
      {#snippet actions()}
        <!-- One copy of it, not a hidden twin per breakpoint: `MemberActions` is interactive
             (dropdown state, ids, handlers), and a second copy would be a second menu per member
             wherever a test environment renders without Tailwind's compiled CSS to apply the
             `hidden` that would otherwise take it out of the accessibility tree. Never on the
             viewer's own row: that's the "Your membership" section's job, not this menu's. -->
        {#if viewerRole === 'admin' && !member.isYou}
          <MemberActions
            {organizationSlug}
            {member}
            onDone={() => invalidate(MEMBERS_DEPENDENCY)}
          />
        {:else if viewerRole === 'admin'}
          <!-- Holds the menu's place, so the viewer's role lines up with everyone else's. -->
          <span class="size-9 shrink-0"></span>
        {/if}
      {/snippet}
    </ItemListRow>
  {/snippet}
</ItemList>
