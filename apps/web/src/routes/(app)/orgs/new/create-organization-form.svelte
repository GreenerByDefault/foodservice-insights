<script lang="ts">
import { goto } from '$app/navigation';
import OrganizationNameForm from '$lib/components/orgs/organization-name-form.svelte';
import { createOrganization } from '$lib/orgs/api/create-organization';

async function handleSubmit(name: string): Promise<'done' | 'name-taken' | 'unknown'> {
  const outcome = await createOrganization(name);
  if (outcome.kind !== 'created') return outcome.kind;

  // Stay `submitting` — the button must remain disabled while this navigation is pending.
  await goto(outcome.location);
  return 'done';
}
</script>

{#snippet unknownNotice()}
  We're not sure whether that went through. Check
  <a class="underline" href="/orgs">your organizations</a>
  before trying again.
{/snippet}

<OrganizationNameForm
  initialName=""
  submitLabel="Create organization"
  submittingLabel="Creating…"
  {unknownNotice}
  onSubmit={handleSubmit}
/>
