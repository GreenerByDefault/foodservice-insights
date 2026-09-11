<script lang="ts">
import type { OrganizationRole } from '@gbd/db';
import { invalidateAll } from '$app/navigation';
import ItemList from '$lib/components/item-list.svelte';
import MemberActions from './member-actions.svelte';
import type { MemberRow } from './+page.server.ts';

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
  {#snippet children(member)}
    <!-- `items-center` centers the menu against the row as a whole — beside all three stacked
         lines below `sm` — rather than pinned to one of them. `flex-wrap` is for
         `MemberActions`' error message, not for anything above: that message has `basis-full`,
         and a flex item asking for the row's full width never fits next to what's already on
         the line, so it always wraps onto a row of its own below, without shifting the
         name/role/menu items that come before it. -->
    <li class="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-2 py-3">
      <!-- Stacked name / email / role below `sm`, where the row is too narrow for the name and
           the role to share a line without truncating the name hard; one line at `sm` and up. -->
      <span
        class="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      >
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
      </span>
      <!-- One copy of it, not a hidden twin per breakpoint: `MemberActions` is interactive
           (dropdown state, ids, handlers), and a second copy would be a second menu per member
           wherever a test environment renders without Tailwind's compiled CSS to apply the
           `hidden` that would otherwise take it out of the accessibility tree. -->
      <!-- This PR only offers a role change, admin-only; a member sees no menu on any row yet. -->
      {#if viewerRole === 'admin'}
        <MemberActions {organizationSlug} {member} onDone={invalidateAll} />
      {/if}
    </li>
  {/snippet}
</ItemList>
