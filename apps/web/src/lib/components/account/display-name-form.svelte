<script lang="ts">
import { toast } from 'svelte-sonner';
import { FIELD, MAX_DISPLAY_NAME_LENGTH } from '#lib/account/display-name.js';
import { renameSelf } from '#lib/account/api/rename-self.js';
import { Button } from '#lib/components/ui/button/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';
import { MIN_NAME_LENGTH } from '#lib/forms/validation.js';

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
  const trimmedName = name.trim();
  const outcome = await renameSelf(trimmedName);
  if (outcome.kind === 'unknown') {
    formState = 'outcome-unknown';
    return;
  }

  await onSaved();
  toast.success(`Name updated to ${trimmedName}`);
  formState = 'idle';
}
</script>

<form onsubmit={handleSubmit} class="flex flex-col gap-4">
  <Field.Field>
    <Field.Label for={FIELD.displayName}>Your name</Field.Label>
    <Input
      id={FIELD.displayName}
      name={FIELD.displayName}
      minlength={MIN_NAME_LENGTH}
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
