<script lang="ts">
import { toast } from 'svelte-sonner';
import { FIELD, MAX_DISPLAY_NAME_LENGTH } from '$lib/account/display-name';
import { renameSelf } from '$lib/account/api/rename-self';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';

interface Props {
  initialName: string;
  submitLabel: string;
  onSaved: () => Promise<void>;
}

let { initialName, submitLabel, onSaved }: Props = $props();

// Seeded once and never re-synced, so `onSaved`'s `invalidateAll()` cannot clobber an edit — the
// same reason as `organization-name-form.svelte`.
// svelte-ignore state_referenced_locally
let name = $state(initialName);

let formState: 'idle' | 'submitting' | 'outcome-unknown' = $state('idle');

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState === 'submitting') return;

  formState = 'submitting';
  const outcome = await renameSelf(name.trim());
  if (outcome.kind === 'unknown') {
    formState = 'outcome-unknown';
    return;
  }

  await onSaved();
  toast.success('Your name was updated');
  formState = 'idle';
}
</script>

<form onsubmit={handleSubmit} class="flex flex-col gap-4">
  <Field.Field>
    <Field.Label for={FIELD.displayName}>Your name</Field.Label>
    <Input
      id={FIELD.displayName}
      name={FIELD.displayName}
      maxlength={MAX_DISPLAY_NAME_LENGTH}
      required
      autocomplete="name"
      bind:value={name}
    />
    <Field.Description>How the other members of your organizations see you.</Field.Description>
  </Field.Field>

  {#if formState === 'outcome-unknown'}
    <p role="alert" class="text-sm text-destructive">
      We're not sure whether your name was saved. Reload the page to check before trying again.
    </p>
  {/if}

  <Button
    type="submit"
    class="self-start"
    disabled={formState === 'submitting'}
    aria-busy={formState === 'submitting'}
  >
    {formState === 'submitting' ? 'Saving…' : submitLabel}
  </Button>
</form>
