<script lang="ts">
import { XLSX_CONTENT_TYPE } from '@gbd/core';
import type { CountsBasis, UnitSystem } from '@gbd/db';
import { tick } from 'svelte';
import { goto } from '$app/navigation';
import { Alert, AlertDescription } from '#lib/components/ui/alert/index.js';
import { Button } from '#lib/components/ui/button/index.js';
import * as FileDropZone from '#lib/components/ui/file-drop-zone/index.js';
import type { FileRejectedReason } from '#lib/components/ui/file-drop-zone/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';
import { RadioGroup, RadioGroupItem } from '#lib/components/ui/radio-group/index.js';
import { MIN_NAME_LENGTH } from '#lib/forms/validation.js';
import { organizationHref } from '#lib/hrefs.js';
import { inspectFile } from '#lib/reports/inspect-file.js';
import {
  MAX_FREE_TEXT_LENGTH,
  MAX_UPLOAD_FIELD_BYTES,
  MAX_UPLOAD_FIELD_MEGABYTES,
} from '#lib/reports/limits.js';
import { COUNTS_BASES, FIELD, UNIT_SYSTEMS } from '#lib/reports/metadata.js';
import { type CountDraft, reconcileDraft, serializeCounts } from '#lib/reports/monthly-counts.js';
import { userFacingRejection, type UploadRejection } from '#lib/reports/rejection.js';
import { uploadReport } from '#lib/reports/api/upload-report.js';
import MonthlyCounts from './monthly-counts.svelte';
import RejectionView from './rejection-view.svelte';

interface Props {
  organizationSlug: string;
  rateLimitWarning?: string;
}

let { organizationSlug, rateLimitWarning }: Props = $props();

// Every field's value lives here, in the component's own state, rather than only in the DOM —
// so swapping to the rejection view and back never loses what the user already typed.
let upload: { csvFile: File; workbook?: File } | undefined = $state();
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

/** A hint to the file picker only; what a file actually is, `inspectFile` decides from its bytes. */
const ACCEPTED_FILE_TYPES = `.csv,text/csv,.xlsx,${XLSX_CONTENT_TYPE}`;

// Each swap between the drop zone, the file-name row and the rejection view unmounts the focused
// element, which would drop focus to <body> and send Tab back to the header; these are where it
// lands instead.
let fileInputElement: HTMLInputElement | null = $state(null);
let replaceButtonElement: HTMLButtonElement | HTMLAnchorElement | null = $state(null);

let unitSystemElement: HTMLElement | null = $state(null);
const id = $props.id();
const unitSystemErrorId = `${id}-unit-system-error`;
const unitSystemTitleId = `${id}-unit-system-title`;
const countsBasisTitleId = `${id}-counts-basis-title`;

function fileRejectionMessage(reason: FileRejectedReason): string {
  switch (reason) {
    case 'File type not allowed':
      return 'We can read CSV and Excel (.xlsx) files. For an older .xls file, in Excel choose File → Save As → Excel Workbook (.xlsx).';
    case 'Maximum file size exceeded':
      return `That file is larger than ${MAX_UPLOAD_FIELD_MEGABYTES}MB.`;
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

  // Shown during "Checking your file…" before inspection names the actual upload.
  upload = { csvFile: chosen };
  fileError = undefined;
  formState = { status: 'checking' };
  // Yields once so the "Checking your file…" state paints before the normalizer locks the main
  // thread.
  await new Promise((resolve) => setTimeout(resolve));

  const inspection = await inspectFile(chosen);
  if (!inspection.ok) {
    formState = { status: 'rejected', rejection: userFacingRejection(inspection.rejection) };
    upload = undefined;
    months = undefined;
    return;
  }

  upload = inspection.upload;
  months = inspection.months;
  counts = reconcileDraft(counts, months);
  formState = { status: 'idle' };
  await tick();
  // Inspecting a large workbook takes long enough to start on the next field meanwhile.
  if (document.activeElement === document.body) replaceButtonElement?.focus();
}

async function replaceFile() {
  upload = undefined;
  months = undefined;
  fileError = undefined;
  formState = { status: 'idle' };
  await tick();
  fileInputElement?.focus();
}

async function handleSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  // `currentTarget` is null once dispatch ends, so it must be read before the first `await`.
  const form = event.currentTarget;
  event.preventDefault();
  if (formState.status === 'submitting') return;

  // Two traps native validation can't see: the chosen file lives in component state, not the
  // drop zone's input (which is cleared after every pick and unmounted once a file is chosen), and
  // a `RadioGroup` submits through a hidden input (`required` on it is a no-op). Both need a
  // hand-written check, an inline message, and a manual focus — a failed submit otherwise gives
  // the user no locator.
  const chosenUpload = upload;
  fileError = chosenUpload ? undefined : 'Choose a CSV or Excel file to upload.';
  unitSystemError = unitSystem ? undefined : 'Choose lb or kg.';

  if (!chosenUpload) {
    fileInputElement?.focus();
    return;
  }
  if (!unitSystem) {
    // The radiogroup root has no tabindex, so focusing it is a no-op.
    unitSystemElement?.querySelector<HTMLElement>('[role=radio]')?.focus();
    return;
  }

  // Unreachable in practice — every month input carries `required`, so native validation blocks
  // the submit event before this runs. `serializeCounts` returning `null` is the caller's cue not
  // to submit, kept as a safety net rather than an `as string` cast on its result.
  const serialized = serializeCounts(counts, months ?? []);
  if (serialized === null) return;

  const formData = new FormData(form);
  formData.set(FIELD.csvFile, chosenUpload.csvFile);
  // The original, for the server to store without ever opening it.
  if (chosenUpload.workbook) formData.set(FIELD.workbook, chosenUpload.workbook);
  formData.set(FIELD.monthlyCounts, serialized);

  formState = { status: 'submitting' };
  const outcome = await uploadReport(organizationSlug, formData);

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

async function backToForm() {
  formState = { status: 'idle' };
  await tick();
  // A file the server rejected is still chosen, so there is no drop zone to return to.
  (fileInputElement ?? replaceButtonElement)?.focus();
}
</script>

{#if formState.status === 'rejected'}
  <RejectionView rejection={formState.rejection} onBack={backToForm} />
{:else}
  <form onsubmit={handleSubmit} class="space-y-8">
    {#if rateLimitWarning}
      <Alert>
        <AlertDescription>{rateLimitWarning}</AlertDescription>
      </Alert>
    {/if}

    <Field.Set>
      <Field.Legend>File</Field.Legend>
      <Field.Description>
        A CSV or Excel workbook with three columns: product name, date ordered, and weight. Up to
        {MAX_UPLOAD_FIELD_MEGABYTES}MB.
      </Field.Description>

      {#if upload}
        <div class="flex items-center justify-between gap-4 rounded-md border p-3">
          <p class="min-w-0 truncate font-medium">{upload.workbook?.name ?? upload.csvFile.name}</p>
          <Button
            bind:ref={replaceButtonElement}
            type="button"
            variant="outline"
            onclick={replaceFile}
          >
            Replace
          </Button>
        </div>
      {:else}
        <FileDropZone.Root
          maxFiles={1}
          fileCount={0}
          maxFileSize={MAX_UPLOAD_FIELD_BYTES}
          accept={ACCEPTED_FILE_TYPES}
          onUpload={inspectChosenFile}
          {onFileRejected}
          bind:ref={fileInputElement}
        >
          <FileDropZone.Trigger label="Choose a CSV or Excel file" />
        </FileDropZone.Root>
      {/if}
      <!-- Mounted whatever the state: a live region that appears along with its text is read by
           nobody. `sr-only` while empty, rather than `hidden`, keeps it out of the field set's gap
           without taking it out of the accessibility tree. -->
      <p
        role="status"
        class={formState.status === 'checking' ? 'text-sm text-muted-foreground' : 'sr-only'}
      >
        {#if formState.status === 'checking'}
          Checking your file…
        {/if}
      </p>

      {#if fileError}
        <Field.Error>{fileError}</Field.Error>
      {/if}
    </Field.Set>

    <Field.Set>
      <Field.Legend>Report details</Field.Legend>

      <Field.Field>
        <Field.Label for={FIELD.name}>Report name</Field.Label>
        <Input
          id={FIELD.name}
          name={FIELD.name}
          minlength={MIN_NAME_LENGTH}
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
          minlength={MIN_NAME_LENGTH}
          maxlength={MAX_FREE_TEXT_LENGTH}
          autocomplete="off"
          bind:value={siteName}
        />
      </Field.Field>

      <Field.Field>
        <Field.Title id={unitSystemTitleId}>Weight unit</Field.Title>
        <RadioGroup
          bind:ref={unitSystemElement}
          aria-labelledby={unitSystemTitleId}
          name={FIELD.unitSystem}
          aria-invalid={unitSystemError ? true : undefined}
          aria-describedby={unitSystemError ? unitSystemErrorId : undefined}
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
          <Field.Error id={unitSystemErrorId}>{unitSystemError}</Field.Error>
        {/if}
      </Field.Field>
    </Field.Set>

    <Field.Set>
      <Field.Legend>Monthly counts</Field.Legend>

      <Field.Field>
        <Field.Title id={countsBasisTitleId}>Counts basis</Field.Title>
        <RadioGroup
          aria-labelledby={countsBasisTitleId}
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
        <a class="underline" href={organizationHref(organizationSlug)}>your reports</a>
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
