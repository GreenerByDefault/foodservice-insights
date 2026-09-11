<script lang="ts">
import type { OrganizationRole } from '@gbd/db';
import { goto, invalidateAll } from '$app/navigation';
import ConfirmAction, { ConfirmActionError } from '$lib/components/confirm-action.svelte';
import * as Field from '$lib/components/ui/field';
import { changeMemberRole } from '$lib/orgs/api/change-member-role';
import { removeMember } from '$lib/orgs/api/remove-member';

/** The page-level section for actions on the viewer's own row — the counterpart to
 * `member-actions.svelte`'s per-row menu, which only acts on other people. Step down is
 * admin-only; Leave is offered to any viewer who holds a row. */
interface Props {
  organizationSlug: string;
  viewerUserId: string;
  viewerRole: OrganizationRole;
}

let { organizationSlug, viewerUserId, viewerRole }: Props = $props();

async function stepDown() {
  const outcome = await changeMemberRole(organizationSlug, viewerUserId, 'member');
  if (outcome.kind === 'last-admin') {
    throw new ConfirmActionError("You're the only admin. Make someone else an admin first.");
  }
  if (outcome.kind === 'unknown') {
    throw new Error('unknown');
  }
  await invalidateAll();
}

async function leave() {
  const outcome = await removeMember(organizationSlug, viewerUserId);
  if (outcome.kind === 'last-admin') {
    throw new ConfirmActionError("You're the only admin. Make someone else an admin first.");
  }
  if (outcome.kind === 'unknown') {
    throw new Error('unknown');
  }
  // Same landing as delete-organization: `/orgs` forwards to a remaining organization, or
  // `/orgs/new` if this was the viewer's last.
  await goto('/orgs', { invalidateAll: true });
}
</script>

{#snippet stepDownTrigger()}
  Step down as admin
{/snippet}

{#snippet leaveTrigger()}
  Leave organization
{/snippet}

<Field.Set>
  <Field.Legend>Your membership</Field.Legend>
  <Field.Description>
    {viewerRole === 'admin'
      ? "You're an admin of this organization."
      : "You're a member of this organization."}
  </Field.Description>
  {#if viewerRole === 'admin'}
    <ConfirmAction
      trigger={stepDownTrigger}
      title="Step down as admin?"
      description="You'll lose admin access to this organization. Another admin can make you one again."
      confirmLabel="Yes, step down"
      cancelLabel="Stay admin"
      errorMessage="Could not update your role. Please try again."
      onConfirm={stepDown}
    />
  {/if}
  <ConfirmAction
    trigger={leaveTrigger}
    title="Leave this organization?"
    description="You'll lose access to its reports and files. Another admin can add you back."
    confirmLabel="Yes, leave"
    cancelLabel="Stay"
    errorMessage="Could not leave this organization. Please try again."
    onConfirm={leave}
  />
</Field.Set>
