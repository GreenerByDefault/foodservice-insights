<script lang="ts">
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import ConfirmAction from '#lib/components/confirm-action.svelte';
import * as Field from '#lib/components/ui/field/index.js';
import { deleteOrganization } from '#lib/orgs/api/delete-organization.js';

interface Props {
  organizationSlug: string;
  organizationName: string;
}

let { organizationSlug, organizationName }: Props = $props();

async function confirm() {
  await deleteOrganization(organizationSlug);
  // The switcher and org list both read from the layout load this refreshes; from `/orgs`,
  // `_organizationsPageRedirect` lands the user on a remaining organization, or `/orgs/new`
  // if that was their last.
  await goto('/orgs', { invalidateAll: true });
  toast.success(`Deleted ${organizationName}`);
}
</script>

{#snippet trigger()}
  <Trash2Icon aria-hidden="true" />
  Delete organization
{/snippet}

<Field.Set>
  <Field.Legend>Delete organization</Field.Legend>
  <Field.Description>
    This permanently deletes {organizationName} — its reports and files go with it. This can't be
    undone.
  </Field.Description>
  <ConfirmAction
    {trigger}
    title="Delete {organizationName}?"
    description="This removes the organization, its reports, and its files permanently. This can't be undone."
    confirmLabel="Yes, delete organization"
    cancelLabel="Keep it"
    errorMessage="Could not delete this organization. Please try again."
    confirmPhrase={organizationName}
    onConfirm={confirm}
  />
</Field.Set>
