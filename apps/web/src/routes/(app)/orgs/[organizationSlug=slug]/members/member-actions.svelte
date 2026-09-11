<script lang="ts">
import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
import ConfirmAction, { ConfirmActionError } from '$lib/components/confirm-action.svelte';
import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import type { ActionState } from '$lib/forms/action-state';
import { changeMemberRole } from '$lib/orgs/api/change-member-role';
import { removeMember } from '$lib/orgs/api/remove-member';
import type { MemberRow } from './+page.server.ts';

/** The per-row "⋯" menu on the Members page — never rendered for the viewer's own row (see
 * `members-list.svelte`), so every action here is unconditionally about someone else. */
interface Props {
  organizationSlug: string;
  member: MemberRow;
  onDone: () => Promise<void>;
}

let { organizationSlug, member, onDone }: Props = $props();

let actionState = $state<ActionState>({ status: 'idle' });
let removeDialogOpen = $state(false);

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

// Reachable for a superadmin removing an organization's only admin — an ordinary admin's own row
// never has this menu, since the demotion path to it is Step down, not Remove.
async function remove() {
  const outcome = await removeMember(organizationSlug, member.userId);
  if (outcome.kind === 'last-admin') {
    throw new ConfirmActionError("You're the only admin. Make someone else an admin first.");
  }
  if (outcome.kind === 'unknown') {
    throw new Error('unknown');
  }
  await onDone();
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
      <DropdownMenu.Item onSelect={() => setRole('member')}>Make member</DropdownMenu.Item>
    {/if}
    <DropdownMenu.Separator />
    <!-- The menu closes as this is selected, so the dialog can't be this item's own
         `AlertDialogTrigger` — it drives `bind:open` below instead. -->
    <DropdownMenu.Item variant="destructive" onSelect={() => (removeDialogOpen = true)}>
      Remove from organization
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

{#if actionState.status === 'error'}
  <!-- `basis-full`: forces this onto its own line of the row's `flex-wrap` — see the comment on
       `<li>` in members-list.svelte. -->
  <p role="alert" class="basis-full text-sm text-destructive">{actionState.message}</p>
{/if}

<ConfirmAction
  bind:open={removeDialogOpen}
  title="Remove {member.displayName ?? member.email}?"
  description="They'll lose access to this organization's reports and files."
  confirmLabel="Yes, remove"
  cancelLabel="Cancel"
  errorMessage="Could not remove this member. Please try again."
  onConfirm={remove}
/>
