<script lang="ts">
import { invalidateAll } from '$app/navigation';
import OrganizationNameForm from '$lib/components/orgs/organization-name-form.svelte';
import { renameOrganization } from '$lib/orgs/api/rename-organization';

interface Props {
  organizationSlug: string;
  initialName: string;
}

let { organizationSlug, initialName }: Props = $props();

async function handleSubmit(name: string): Promise<'done' | 'name-taken' | 'unknown'> {
  const outcome = await renameOrganization(organizationSlug, name);
  if (outcome.kind !== 'renamed') return outcome.kind;

  // The switcher and the org shell both read from the layout load this refreshes.
  await invalidateAll();
  return 'done';
}
</script>

{#snippet unknownNotice()}
  We're not sure whether that rename went through. Reload the page to check the current name before
  trying again.
{/snippet}

<OrganizationNameForm
  {initialName}
  legend="Rename organization"
  submitLabel="Save"
  submittingLabel="Saving…"
  {unknownNotice}
  onSubmit={handleSubmit}
/>
