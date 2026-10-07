<script lang="ts">
import type { OrganizationRole } from '@gbd/db';
import { toast } from 'svelte-sonner';
import { goto, refreshAll } from '$app/navigation';
import ConfirmAction from '#lib/components/confirm-action.svelte';
import * as Field from '#lib/components/ui/field/index.js';
import { changeMemberRole } from '#lib/orgs/api/change-member-role.js';
import { removeMember } from '#lib/orgs/api/remove-member.js';
import { confirmMemberWrite } from './member-write.ts';

/** The page-level section for actions on the viewer's own row — the counterpart to
 * `member-actions.svelte`'s per-row menu, which only acts on other people. Step down is
 * admin-only; Leave is offered to any viewer who holds a row. */
interface Props {
  organizationSlug: string;
  viewerUserId: string;
  viewerRole: OrganizationRole;
  organizationName: string;
}

let { organizationSlug, viewerUserId, viewerRole, organizationName }: Props = $props();

async function stepDown() {
  confirmMemberWrite(await changeMemberRole(organizationSlug, viewerUserId, 'member'));
  await refreshAll();
  toast.success(`You're no longer an admin of ${organizationName}`);
}

async function leave() {
  confirmMemberWrite(await removeMember(organizationSlug, viewerUserId));
  // Same landing as delete-organization: `/orgs` forwards to a remaining organization, or
  // `/orgs/new` if this was the viewer's last.
  await goto('/orgs', { refreshAll: true });
  toast.success(`You left ${organizationName}`);
}
</script>

{#snippet stepDownTrigger()}
  Step down as admin
{/snippet}

{#snippet leaveTrigger()}
  Leave organization
{/snippet}

<Field.Set class="gap-3">
  <Field.Description>
    {viewerRole === 'admin'
      ? "You're an admin of this organization."
      : "You're a member of this organization."}
  </Field.Description>
  <div class="flex flex-wrap gap-2">
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
  </div>
</Field.Set>
