<script lang="ts">
import { invalidateAll } from '$app/navigation';
import ConfirmAction, { ConfirmActionError } from '$lib/components/confirm-action.svelte';
import * as Field from '$lib/components/ui/field';
import { changeMemberRole } from '$lib/orgs/api/change-member-role';

/** The page-level section for actions on the viewer's own row — the counterpart to
 * `member-actions.svelte`'s per-row menu, which only acts on other people. */
interface Props {
  organizationSlug: string;
  viewerUserId: string;
}

let { organizationSlug, viewerUserId }: Props = $props();

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
</script>

{#snippet trigger()}
  Step down as admin
{/snippet}

<Field.Set>
  <Field.Legend>Your membership</Field.Legend>
  <Field.Description>You're an admin of this organization.</Field.Description>
  <ConfirmAction
    {trigger}
    title="Step down as admin?"
    description="You'll lose admin access to this organization. Another admin can make you one again."
    confirmLabel="Yes, step down"
    cancelLabel="Stay admin"
    errorMessage="Could not update your role. Please try again."
    onConfirm={stepDown}
  />
</Field.Set>
