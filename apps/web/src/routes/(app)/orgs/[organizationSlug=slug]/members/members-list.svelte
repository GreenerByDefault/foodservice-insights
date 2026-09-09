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

/** Whether the viewer is the organization's only admin — the reason `MemberActions` disables
 * demoting them out of the role. */
const soleAdmin = $derived(
  members.filter((member) => member.role === 'admin').length === 1 &&
    members.some((member) => member.role === 'admin' && member.isYou),
);
</script>

<!-- No empty state: `organization_check_has_member` makes an empty list impossible. -->
<ItemList items={members} key={(member) => member.userId} empty="">
  {#snippet children(member)}
    <li class="flex w-full items-center justify-between gap-4 px-2 py-3">
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
      <!-- One flex group, not two `justify-between` children: keeps the role label and the
           menu button pinned together at the trailing edge instead of `justify-between` spacing
           all three of this row's top-level children evenly across it. -->
      <span class="flex shrink-0 items-center gap-4">
        <span class="text-sm text-muted-foreground">{ROLE_LABEL[member.role]}</span>
        <!-- This PR only offers a role change, admin-only; a member sees no menu on any row yet. -->
        {#if viewerRole === 'admin'}
          <MemberActions {organizationSlug} {member} {soleAdmin} onDone={invalidateAll} />
        {/if}
      </span>
    </li>
  {/snippet}
</ItemList>
