<script lang="ts">
import { invalidateAll } from '$app/navigation';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import { renameOrganization } from '$lib/orgs/api/rename-organization';
import { FIELD, MAX_ORGANIZATION_NAME_LENGTH } from '$lib/orgs/name';

interface Props {
  organizationId: string;
  name: string;
}

// Reassigning `name` below temporarily overrides the prop with the user's in-progress edit — the
// documented pattern for unsaved, ephemeral state — rather than seeding a separate `$state` from
// it, which the compiler would (rightly) flag as capturing only the initial value.
let { organizationId, name }: Props = $props();

type FormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'name-taken' }
  | { status: 'outcome-unknown' };

let formState: FormState = $state({ status: 'idle' });
let nameInputElement: HTMLInputElement | null = $state(null);

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'submitting') return;

  formState = { status: 'submitting' };
  const outcome = await renameOrganization(organizationId, name.trim());

  if (outcome.kind === 'renamed') {
    // The switcher and the org shell both read from the layout load this refreshes.
    await invalidateAll();
    formState = { status: 'idle' };
    return;
  }

  if (outcome.kind === 'name-taken') {
    formState = { status: 'name-taken' };
    nameInputElement?.focus();
    return;
  }

  formState = { status: 'outcome-unknown' };
}
</script>

<form onsubmit={handleSubmit} class="w-full space-y-8">
  <Field.Field>
    <Field.Label for="organization-name">Organization name</Field.Label>
    <Input
      bind:ref={nameInputElement}
      id="organization-name"
      name={FIELD.name}
      maxlength={MAX_ORGANIZATION_NAME_LENGTH}
      required
      autocomplete="off"
      bind:value={name}
    />
    {#if formState.status === 'name-taken'}
      <Field.Error>An organization with that name already exists.</Field.Error>
    {/if}
  </Field.Field>

  {#if formState.status === 'outcome-unknown'}
    <p role="alert" class="text-sm text-destructive">
      We're not sure whether that rename went through. Reload the page to check the current name
      before trying again.
    </p>
  {/if}

  <Button
    type="submit"
    disabled={formState.status === 'submitting'}
    aria-busy={formState.status === 'submitting'}
  >
    {formState.status === 'submitting' ? 'Saving…' : 'Save'}
  </Button>
</form>
