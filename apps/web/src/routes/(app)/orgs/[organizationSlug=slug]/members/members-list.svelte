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
    <li class="w-full px-2 py-3">
      <!-- One layout, not a duplicated one per breakpoint: `MemberActions` is a real interactive
           component (dropdown state, ids, handlers), so a hidden/sm-shown twin of it — like
           `ReportRow` gets away with for plain text — would exist twice in the DOM. That breaks
           "one menu per member" wherever a test environment doesn't load Tailwind's compiled CSS
           to actually apply the `hidden` that would otherwise make the browser exclude it.
           Instead, `flex-wrap` reflows a single copy: the name/email block claims the full row
           width below `sm`, so nothing else fits beside it and the role+menu group wraps to its
           own line; at `sm` and up it gives up that full-width claim and shares the row, matching
           the original single-row desktop layout. -->
      <span class="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
        <span class="flex min-w-0 basis-full flex-col sm:basis-0 sm:flex-1">
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
        <!-- `ms-auto` pins this group to the trailing edge of whichever line it lands on — the
             end of the row at `sm` and up, the end of its own wrapped line below `sm` — the same
             job `justify-between` did on the single-row version this replaced. -->
        <span class="ms-auto flex shrink-0 items-center gap-4">
          <span class="text-sm text-muted-foreground">{ROLE_LABEL[member.role]}</span>
          <!-- This PR only offers a role change, admin-only; a member sees no menu on any row yet. -->
          {#if viewerRole === 'admin'}
            <MemberActions {organizationSlug} {member} onDone={invalidateAll} />
          {/if}
        </span>
      </span>
    </li>
  {/snippet}
</ItemList>
