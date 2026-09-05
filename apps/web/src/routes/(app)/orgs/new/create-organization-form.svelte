<script lang="ts">
import { goto } from '$app/navigation';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import { createOrganization } from '$lib/orgs/api/create-organization';
import { FIELD, MAX_ORGANIZATION_NAME_LENGTH } from '$lib/orgs/name';

let name = $state('');

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
  const outcome = await createOrganization(name.trim());

  if (outcome.kind === 'created') {
    // Stay `submitting` — the button must remain disabled while this navigation is pending.
    await goto(outcome.location);
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

<form onsubmit={handleSubmit} class="space-y-8">
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
      We're not sure whether that went through. Check
      <a class="underline" href="/orgs">your organizations</a>
      before trying again.
    </p>
  {/if}

  <Button
    type="submit"
    disabled={formState.status === 'submitting'}
    aria-busy={formState.status === 'submitting'}
  >
    {formState.status === 'submitting' ? 'Creating…' : 'Create organization'}
  </Button>
</form>
