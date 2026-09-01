<script lang="ts">
import type { CountsBasis, UnitSystem } from '@gbd/db';
import { goto } from '$app/navigation';
import { Alert, AlertDescription } from '$lib/components/ui/alert';
import { Button } from '$lib/components/ui/button';
import * as FileDropZone from '$lib/components/ui/file-drop-zone';
import type { FileRejectedReason } from '$lib/components/ui/file-drop-zone';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group';
import { organizationHref } from '$lib/reports/hrefs';
import { inspectFile } from '$lib/reports/inspect-file';
import { MAX_FREE_TEXT_LENGTH, MAX_UPLOAD_BYTES, MAX_UPLOAD_MEGABYTES } from '$lib/reports/limits';
import { COUNTS_BASES, FIELD, UNIT_SYSTEMS } from '$lib/reports/metadata';
import { type CountDraft, reconcileDraft, serializeCounts } from '$lib/reports/monthly-counts';
import { userFacingRejection, type UploadRejection } from '$lib/reports/rejection';
import { uploadReport } from '$lib/reports/upload';
import MonthlyCounts from './monthly-counts.svelte';
import RejectionView from './rejection-view.svelte';

interface Props {
  organizationId: string;
  rateLimitWarning?: string;
}

let { organizationId, rateLimitWarning }: Props = $props();

// Every field's value lives here, in the component's own state, rather than only in the DOM —
// so swapping to the rejection view and back never loses what the user already typed.
let file: File | undefined = $state();
let months: readonly string[] | undefined = $state();
let counts: CountDraft = $state({});
let name = $state('');
let siteName = $state('');
let countsBasis: CountsBasis = $state('people');
let unitSystem: UnitSystem | undefined = $state();

type FormState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'submitting' }
  | { status: 'rejected'; rejection: UploadRejection }
  | { status: 'outcome-unknown' };

let formState: FormState = $state({ status: 'idle' });

let fileError: string | undefined = $state();
let unitSystemError: string | undefined = $state();

let formElement: HTMLFormElement | undefined = $state();
let dropZoneTriggerElement: HTMLElement | null = $state(null);
let unitSystemElement: HTMLElement | null = $state(null);

function fileRejectionMessage(reason: FileRejectedReason): string {
  switch (reason) {
    case 'File type not allowed':
      return 'We can only read CSV files right now. In Excel, choose File → Save As → CSV.';
    case 'Maximum file size exceeded':
      return `That file is larger than ${MAX_UPLOAD_MEGABYTES}MB.`;
    case 'Maximum files uploaded':
      return 'Choose only one file.';
  }
}

function onFileRejected({ reason }: { reason: FileRejectedReason; file: File }) {
  fileError = fileRejectionMessage(reason);
}

async function inspectChosenFile(files: File[]) {
  const chosen = files[0];
  if (!chosen) return;

  file = chosen;
  fileError = undefined;
  formState = { status: 'checking' };
  // Yields once so the "Checking your file…" state paints before the normalizer locks the main
  // thread.
  await new Promise((resolve) => setTimeout(resolve));

  const inspection = await inspectFile(chosen);
  if (!inspection.ok) {
    formState = { status: 'rejected', rejection: userFacingRejection(inspection.rejection) };
    file = undefined;
    months = undefined;
    return;
  }

  months = inspection.months;
  counts = reconcileDraft(counts, months);
  formState = { status: 'idle' };
}

function replaceFile() {
  file = undefined;
  months = undefined;
  fileError = undefined;
  formState = { status: 'idle' };
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'submitting') return;
  const form = formElement;
  if (!form) return;

  // Two traps native validation can't see: the drop zone's file input is hidden (`required`
  // there produces a console error and no visible message), and a `RadioGroup` submits through
  // a hidden input (`required` on it is a no-op). Both need a hand-written check, an inline
  // message, and a manual focus/scroll — a failed submit otherwise gives the user no locator.
  const chosenFile = file;
  fileError = chosenFile ? undefined : 'Choose a CSV file to upload.';
  unitSystemError = unitSystem ? undefined : 'Choose lb or kg.';

  if (!chosenFile) {
    dropZoneTriggerElement?.scrollIntoView({ block: 'center' });
    dropZoneTriggerElement?.focus();
    return;
  }
  if (!unitSystem) {
    unitSystemElement?.focus();
    return;
  }

  // Unreachable in practice — every month input carries `required`, so native validation blocks
  // the submit event before this runs. `serializeCounts` returning `null` is the caller's cue not
  // to submit, kept as a safety net rather than an `as string` cast on its result.
  const serialized = serializeCounts(counts, months ?? []);
  if (serialized === null) return;

  const formData = new FormData(form);
  formData.set(FIELD.file, chosenFile);
  formData.set(FIELD.monthlyCounts, serialized);

  formState = { status: 'submitting' };
  const outcome = await uploadReport(organizationId, formData);

  if (outcome.kind === 'created') {
    // Stay `submitting` — the button must remain disabled while this navigation is pending.
    await goto(outcome.location);
    return;
  }

  if (outcome.kind === 'rejected') {
    formState = { status: 'rejected', rejection: outcome.rejection };
    return;
  }

  formState = { status: 'outcome-unknown' };
}

function backToForm() {
  formState = { status: 'idle' };
}
</script>

{#if formState.status === 'rejected'}
  <RejectionView rejection={formState.rejection} onBack={backToForm} />
{:else}
  <form bind:this={formElement} onsubmit={handleSubmit} class="space-y-8">
    {#if rateLimitWarning}
      <Alert>
        <AlertDescription>{rateLimitWarning}</AlertDescription>
      </Alert>
    {/if}

    <Field.Set>
      <Field.Legend>File</Field.Legend>
      <Field.Description>
        A CSV with three columns: product name, date ordered, and weight. Up to
        {MAX_UPLOAD_MEGABYTES}MB.
      </Field.Description>

      {#if file}
        <div class="flex items-center justify-between gap-4 rounded-md border p-3">
          <p class="font-medium">{file.name}</p>
          <Button type="button" variant="outline" onclick={replaceFile}>Replace</Button>
        </div>
        {#if formState.status === 'checking'}
          <p aria-live="polite" class="text-sm text-muted-foreground">Checking your file…</p>
        {/if}
      {:else}
        <FileDropZone.Root
          maxFiles={1}
          fileCount={0}
          maxFileSize={MAX_UPLOAD_BYTES}
          accept=".csv,text/csv"
          onUpload={inspectChosenFile}
          {onFileRejected}
        >
          <FileDropZone.Trigger bind:ref={dropZoneTriggerElement} label="Choose a CSV file" />
        </FileDropZone.Root>
      {/if}

      {#if fileError}
        <Field.Error>{fileError}</Field.Error>
      {/if}
    </Field.Set>

    <Field.Set>
      <Field.Legend>Report details</Field.Legend>

      <Field.Field>
        <Field.Label for="report-name">Report name</Field.Label>
        <Input
          id="report-name"
          name={FIELD.name}
          maxlength={MAX_FREE_TEXT_LENGTH}
          required
          autocomplete="off"
          bind:value={name}
        />
      </Field.Field>

      <Field.Field>
        <Field.Label for="site-name">Site name (optional)</Field.Label>
        <Input
          id="site-name"
          name={FIELD.siteName}
          maxlength={MAX_FREE_TEXT_LENGTH}
          autocomplete="off"
          bind:value={siteName}
        />
      </Field.Field>

      <Field.Field>
        <Field.Legend variant="label">Weight unit</Field.Legend>
        <RadioGroup
          bind:ref={unitSystemElement}
          name={FIELD.unitSystem}
          value={unitSystem}
          onValueChange={(value) => (unitSystem = value as UnitSystem)}
        >
          {#each UNIT_SYSTEMS as system (system)}
            <Field.Label>
              <RadioGroupItem value={system} />
              {system}
            </Field.Label>
          {/each}
        </RadioGroup>
        {#if unitSystemError}
          <Field.Error>{unitSystemError}</Field.Error>
        {/if}
      </Field.Field>
    </Field.Set>

    <Field.Set>
      <Field.Legend>Monthly counts</Field.Legend>

      <Field.Field>
        <Field.Legend variant="label">Counts basis</Field.Legend>
        <RadioGroup
          name={FIELD.countsBasis}
          value={countsBasis}
          onValueChange={(value) => (countsBasis = value as CountsBasis)}
        >
          {#each COUNTS_BASES as basis (basis)}
            <Field.Label>
              <RadioGroupItem value={basis} />
              {basis === 'people' ? 'Diners' : 'Meals'}
            </Field.Label>
          {/each}
        </RadioGroup>
      </Field.Field>

      {#if months}
        <MonthlyCounts {months} basis={countsBasis} bind:counts />
      {:else}
        <Field.Description
          >Choose a file first — we will list the months it covers.</Field.Description
        >
      {/if}
    </Field.Set>

    {#if formState.status === 'outcome-unknown'}
      <p role="alert" class="text-sm text-destructive">
        We're not sure whether that upload went through. Check
        <a class="underline" href={organizationHref(organizationId)}>your reports</a>
        before trying again.
      </p>
    {/if}

    <Button
      type="submit"
      disabled={formState.status === 'checking' || formState.status === 'submitting'}
      aria-busy={formState.status === 'submitting'}
    >
      {formState.status === 'submitting' ? 'Uploading…' : 'Upload report'}
    </Button>
  </form>
{/if}
