<script lang="ts">
import type { Snippet } from 'svelte';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import { FIELD, MAX_ORGANIZATION_NAME_LENGTH } from '$lib/orgs/name';

interface Props {
  initialName: string;
  /** A `Field.Legend` above the field, for a form embedded in a page with other content (the
   * rename form, next to delete). Omitted, the field's own visible label is enough (the
   * create-organization page has nothing else on it). */
  legend?: string;
  submitLabel: string;
  submittingLabel: string;
  unknownNotice: Snippet;
  onSubmit: (name: string) => Promise<'done' | 'name-taken' | 'unknown'>;
}

let { initialName, legend, submitLabel, submittingLabel, unknownNotice, onSubmit }: Props =
  $props();

// Seeded once and never re-synced to `initialName`. Reassigning a destructured prop directly is
// Svelte's documented pattern for unsaved, ephemeral state, but the override only survives until
// the *next* unrelated parent re-render — even one where the org's name hasn't actually changed,
// such as a background `invalidateAll()` — at which point it's silently clobbered back to the
// prop. A local `$state` frozen at mount can't lose an in-progress edit that way.
// svelte-ignore state_referenced_locally
let name = $state(initialName);

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
  const outcome = await onSubmit(name.trim());

  if (outcome === 'done') {
    formState = { status: 'idle' };
    return;
  }

  if (outcome === 'name-taken') {
    formState = { status: 'name-taken' };
    nameInputElement?.focus();
    return;
  }

  formState = { status: 'outcome-unknown' };
}
</script>

{#snippet field()}
  <Field.Field>
    <Field.Label for={FIELD.name} class={legend ? 'sr-only' : undefined}>
      Organization name
    </Field.Label>
    <Input
      bind:ref={nameInputElement}
      id={FIELD.name}
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
      {@render unknownNotice()}
    </p>
  {/if}

  <Button
    type="submit"
    class={legend ? 'self-start' : undefined}
    disabled={formState.status === 'submitting'}
    aria-busy={formState.status === 'submitting'}
  >
    {formState.status === 'submitting' ? submittingLabel : submitLabel}
  </Button>
{/snippet}

<form onsubmit={handleSubmit} class={legend ? 'w-full' : 'space-y-8'}>
  {#if legend}
    <Field.Set>
      <Field.Legend>{legend}</Field.Legend>
      {@render field()}
    </Field.Set>
  {:else}
    {@render field()}
  {/if}
</form>
