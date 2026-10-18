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
import {
  COUNTS_BASES,
  FIELD,
  FIELD_LABELS,
  UNIT_NAMES,
  UNIT_SYSTEMS,
} from '#lib/reports/metadata.js';
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
/** Set when the file's weight header names a unit, which then replaces the Weight unit question. */
let fileWeightUnit: UnitSystem | undefined = $state();
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
const fileIntroId = `${id}-file-intro`;
const otherColumnsId = `${id}-other-columns`;
const reportNameHintId = `${id}-report-name-hint`;
const siteNameHintId = `${id}-site-name-hint`;
const unitSystemHintId = `${id}-unit-system-hint`;
const unitSystemErrorId = `${id}-unit-system-error`;
const unitSystemTitleId = `${id}-unit-system-title`;
const countsMeaningId = `${id}-counts-meaning`;
const countsScopeId = `${id}-counts-scope`;
const countsBasisTitleId = `${id}-counts-basis-title`;

const UNIT_WORDS: Record<UnitSystem, string> = { lb: 'pounds', kg: 'kilograms' };

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
    fileWeightUnit = undefined;
    return;
  }

  upload = inspection.upload;
  months = inspection.months;
  fileWeightUnit = inspection.weightUnit;
  counts = reconcileDraft(counts, months);
  formState = { status: 'idle' };
  await tick();
  // Inspecting a large workbook takes long enough to start on the next field meanwhile.
  if (document.activeElement === document.body) replaceButtonElement?.focus();
}

async function replaceFile() {
  upload = undefined;
  months = undefined;
  fileWeightUnit = undefined;
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
  // `required` on a `RadioGroup` is a no-op. Both need a hand-written check, an inline message,
  // and a manual focus — a failed submit otherwise gives the user no locator.
  const chosenUpload = upload;
  const weightUnit = fileWeightUnit ?? unitSystem;
  fileError = chosenUpload ? undefined : 'Choose a CSV or Excel file to upload.';
  unitSystemError = weightUnit ? undefined : 'Choose pounds or kilograms.';

  if (!chosenUpload) {
    fileInputElement?.focus();
    return;
  }
  if (!weightUnit) {
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
  formData.set(FIELD.unitSystem, weightUnit);
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

    <Field.Set aria-describedby="{fileIntroId} {otherColumnsId}">
      <Field.Legend>Purchasing data</Field.Legend>
      <Field.Description id={fileIntroId}>
        Upload a spreadsheet of what you bought, as a CSV or Excel file up to
        {MAX_UPLOAD_FIELD_MEGABYTES}MB. Its first row should name these three columns:
      </Field.Description>
      <table class="max-w-xl text-left text-sm text-muted-foreground">
        <caption class="sr-only">
          Columns your file needs
        </caption>
        <thead class="sr-only">
          <tr>
            <th scope="col">Column</th>
            <th scope="col">What goes in it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" class="py-1 pr-6 align-top font-normal">Product</th>
            <td class="py-1 align-top">What you bought, such as Chicken breast.</td>
          </tr>
          <tr>
            <th scope="row" class="py-1 pr-6 align-top font-normal">Date</th>
            <td class="py-1 align-top">When you ordered it, such as 2026-01-05.</td>
          </tr>
          <tr>
            <th scope="row" class="py-1 pr-6 align-top font-normal whitespace-nowrap">
              Weight (lb)<br>or Weight (kg)
            </th>
            <td class="py-1 align-top">The weight as a plain number, such as 40 (not "40 lb").</td>
          </tr>
        </tbody>
      </table>
      <Field.Description id={otherColumnsId}>
        Any other columns are fine. We ignore them.
      </Field.Description>

      {#if upload}
        <div class="flex items-center justify-between gap-4 rounded-md border p-3">
          <div class="min-w-0">
            <p class="truncate font-medium">{upload.workbook?.name ?? upload.csvFile.name}</p>
            {#if fileWeightUnit}
              <p class="text-sm text-muted-foreground">
                Weights are in {UNIT_WORDS[fileWeightUnit]}, as the column name says.
              </p>
            {/if}
          </div>
          <Button
            bind:ref={replaceButtonElement}
            type="button"
            variant="outline"
            disabled={formState.status === 'checking'}
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

      {#if months && !fileWeightUnit}
        <Field.Field>
          <Field.Title id={unitSystemTitleId}>{FIELD_LABELS.unitSystem}</Field.Title>
          <Field.Description id={unitSystemHintId}>
            Your weight column doesn't say whether it's in pounds or kilograms. Name it Weight (lb)
            or Weight (kg) next time, and we won't need to ask.
          </Field.Description>
          <RadioGroup
            bind:ref={unitSystemElement}
            aria-labelledby={unitSystemTitleId}
            aria-invalid={unitSystemError ? true : undefined}
            aria-describedby={unitSystemError
              ? `${unitSystemHintId} ${unitSystemErrorId}`
              : unitSystemHintId}
            value={unitSystem}
            onValueChange={(value) => (unitSystem = value as UnitSystem)}
          >
            {#each UNIT_SYSTEMS as system (system)}
              <Field.Label>
                <RadioGroupItem value={system} />
                {UNIT_NAMES[system]}
              </Field.Label>
            {/each}
          </RadioGroup>
          {#if unitSystemError}
            <Field.Error id={unitSystemErrorId}>{unitSystemError}</Field.Error>
          {/if}
        </Field.Field>
      {/if}
    </Field.Set>

    <Field.Set>
      <Field.Legend>Report details</Field.Legend>

      <Field.Field>
        <Field.Label for={FIELD.name}>{FIELD_LABELS.name}</Field.Label>
        <Input
          id={FIELD.name}
          name={FIELD.name}
          minlength={MIN_NAME_LENGTH}
          maxlength={MAX_FREE_TEXT_LENGTH}
          required
          autocomplete="off"
          aria-describedby={reportNameHintId}
          bind:value={name}
        />
        <Field.Description id={reportNameHintId}>For example, Q1 2026 purchases.</Field.Description>
      </Field.Field>

      <Field.Field>
        <Field.Label for="site-name">{FIELD_LABELS.siteName} (optional)</Field.Label>
        <Input
          id="site-name"
          name={FIELD.siteName}
          minlength={MIN_NAME_LENGTH}
          maxlength={MAX_FREE_TEXT_LENGTH}
          autocomplete="off"
          aria-describedby={siteNameHintId}
          bind:value={siteName}
        />
        <Field.Description id={siteNameHintId}>
          The specific location your file covers, such as one dining hall on a university campus.
          Leave blank if your file covers your whole organization.
        </Field.Description>
      </Field.Field>
    </Field.Set>

    <Field.Set aria-describedby="{countsMeaningId} {countsScopeId}">
      <Field.Legend>Diners or meals served</Field.Legend>
      <Field.Description id={countsMeaningId}>
        Enter how many diners or meals you served each month. The report uses these to show your
        emissions per diner or per meal.
      </Field.Description>
      <Field.Description id={countsScopeId}>
        Use counts for the same sites as your file. For example, if your file only covers one dining
        hall, count only that dining hall's diners or meals, not the whole university's.
      </Field.Description>

      <Field.Field>
        <Field.Title id={countsBasisTitleId}>{FIELD_LABELS.countsBasis}</Field.Title>
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
        <a class="link" href={organizationHref(organizationSlug)}>your reports</a>
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
