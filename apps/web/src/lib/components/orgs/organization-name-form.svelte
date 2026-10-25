<script lang="ts">
import type { Snippet } from 'svelte';
import { Button } from '#lib/components/ui/button/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';
import { MIN_NAME_LENGTH } from '#lib/forms/validation.js';
import { MAX_ORGANIZATION_NAME_LENGTH } from '@gbd/db/constraints';
import { FIELD, type OrganizationNameFailure } from '#lib/orgs/name.js';

interface Props {
  initialName: string;
  /** A `Field.Legend` above the field, for a form embedded in a page with other content (the
   * rename form, next to delete). Omitted, the field's own visible label is enough (the
   * create-organization page, where it is the only field). */
  legend?: string;
  description?: string;
  submitLabel: string;
  submittingLabel: string;
  unknownNotice: Snippet;
  onSubmit: (name: string) => Promise<'done' | OrganizationNameFailure>;
}

let {
  initialName,
  legend,
  description,
  submitLabel,
  submittingLabel,
  unknownNotice,
  onSubmit,
}: Props = $props();

// Seeded once and never re-synced to `initialName`. Reassigning a destructured prop directly is
// Svelte's documented pattern for unsaved, ephemeral state, but the override only survives until
// the *next* unrelated parent re-render — even one where the org's name hasn't actually changed,
// such as a background `refreshAll()` — at which point it's silently clobbered back to the
// prop. A local `$state` frozen at mount can't lose an in-progress edit that way.
// svelte-ignore state_referenced_locally
let name = $state(initialName);

type NameFailure = Exclude<OrganizationNameFailure, 'unknown'>;

const FAILURE_MESSAGES: Record<NameFailure, string> = {
  'name-taken': 'An organization with that name already exists.',
  'slug-taken':
    "That name is too close to another organization's. Try adding your region or division.",
  'slug-reserved': "That name isn't available. Try adding your region or division.",
  'slug-underivable': 'That name needs at least one letter or number in a–z or 0–9.',
};

type FormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'failed'; failure: NameFailure }
  | { status: 'outcome-unknown' };

let formState: FormState = $state({ status: 'idle' });
let nameInputElement: HTMLInputElement | null = $state(null);
const id = $props.id();
const nameErrorId = `${id}-name-error`;
const nameDescriptionId = `${id}-name-description`;

const describedBy = $derived.by(
  () =>
    [description && nameDescriptionId, formState.status === 'failed' && nameErrorId]
      .filter(Boolean)
      .join(' ') || undefined,
);

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'submitting') return;

  formState = { status: 'submitting' };
  const outcome = await onSubmit(name.trim());

  if (outcome === 'done') {
    formState = { status: 'idle' };
    return;
  }

  if (outcome === 'unknown') {
    formState = { status: 'outcome-unknown' };
    return;
  }

  formState = { status: 'failed', failure: outcome };
  nameInputElement?.focus();
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
      minlength={MIN_NAME_LENGTH}
      maxlength={MAX_ORGANIZATION_NAME_LENGTH}
      required
      autocomplete="off"
      aria-invalid={formState.status === 'failed' || undefined}
      aria-describedby={describedBy}
      bind:value={name}
    />
    {#if description}
      <Field.Description id={nameDescriptionId}>{description}</Field.Description>
    {/if}
    {#if formState.status === 'failed'}
      <Field.Error id={nameErrorId}>{FAILURE_MESSAGES[formState.failure]}</Field.Error>
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
