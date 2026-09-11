<script lang="ts">
import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import type { ActionState } from '$lib/forms/action-state';
import { changeMemberRole } from '$lib/orgs/api/change-member-role';
import type { MemberRow } from './+page.server.ts';

/** The per-row "⋯" menu on the Members page. */
interface Props {
  organizationSlug: string;
  member: MemberRow;
  onDone: () => Promise<void>;
}

let { organizationSlug, member, onDone }: Props = $props();

let actionState = $state<ActionState>({ status: 'idle' });

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
      <DropdownMenu.Item onSelect={() => setRole('member')}>Make member</DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

{#if actionState.status === 'error'}
  <!-- `basis-full`: forces this onto its own line of the row's `flex-wrap` — see the comment on
       `<li>` in members-list.svelte. -->
  <p role="alert" class="basis-full text-sm text-destructive">{actionState.message}</p>
{/if}
