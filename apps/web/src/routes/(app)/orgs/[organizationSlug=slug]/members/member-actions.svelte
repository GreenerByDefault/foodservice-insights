<script lang="ts">
import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import type { ActionState } from '$lib/forms/action-state';
import { changeMemberRole } from '$lib/orgs/api/change-member-role';
import type { MemberRow } from './+page.server.ts';

/** The per-row "⋯" menu on the Members page. This PR only offers a role change, so it only
 * appears for an admin viewer — see `members-list.svelte`. */
interface Props {
  organizationSlug: string;
  member: MemberRow;
  /** Whether the viewer is the organization's only admin — disables demoting `member` when it's
   * their own admin row, since the trigger would refuse it anyway. */
  soleAdmin: boolean;
  onDone: () => Promise<void>;
}

let { organizationSlug, member, soleAdmin, onDone }: Props = $props();

let actionState = $state<ActionState>({ status: 'idle' });

// `soleAdmin` is only ever true for the viewer's own admin row — there's no other admin left to
// be the one the trigger would refuse to demote.
const demoteDisabled = $derived(member.role === 'admin' && soleAdmin);

async function setRole(role: 'admin' | 'member') {
  actionState = { status: 'loading' };
  const outcome = await changeMemberRole(organizationSlug, member.userId, role);
  if (outcome.kind === 'changed') {
    actionState = { status: 'idle' };
    await onDone();
    return;
  }
  actionState = {
    status: 'error',
    message:
      outcome.kind === 'last-admin'
        ? "You're the only admin. Make someone else an admin first."
        : 'Could not update this member. Please try again.',
  };
}
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon">
        <MoreHorizontalIcon class="size-4" />
        <span class="sr-only">Manage {member.displayName ?? member.email}</span>
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="end">
    {#if member.role === 'member'}
      <DropdownMenu.Item onSelect={() => setRole('admin')}>Make admin</DropdownMenu.Item>
    {:else}
      <DropdownMenu.Item disabled={demoteDisabled} onSelect={() => setRole('member')}>
        Make member
      </DropdownMenu.Item>
      {#if demoteDisabled}
        <DropdownMenu.Label>You're the only admin</DropdownMenu.Label>
      {/if}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

{#if actionState.status === 'error'}
  <p role="alert" class="text-sm text-destructive">{actionState.message}</p>
{/if}
