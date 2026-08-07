<script lang="ts">
import { goto } from '$app/navigation';
import { ApiError, apiCall } from '$lib/api';
import {
  CSV_FILE_ACCEPT,
  MAX_INPUT_FILE_BYTES,
  MAX_REPORT_NAME_LENGTH,
  MAX_SITE_NAME_LENGTH,
} from '$lib/reports/limits';
import { COUNTS_BASES, FIELD, UNIT_SYSTEMS } from '$lib/reports/submission';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

type Submission = { status: 'idle' | 'submitting' } | { status: 'error'; message: string };

let submission = $state<Submission>({ status: 'idle' });

async function handleSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  // The form is posted with fetch, not by the browser, so that the error body can be read.
  event.preventDefault();
  submission = { status: 'submitting' };

  try {
    const response = await apiCall('/api/reports', {
      method: 'POST',
      body: new FormData(event.currentTarget),
    });
    const location = response.headers.get('location');
    if (!location) throw new Error('The server did not say where the report is');
    await goto(location);
  } catch (error) {
    submission = {
      status: 'error',
      message:
        error instanceof ApiError
          ? error.message
          : 'Something went wrong. Please try again in a moment.',
    };
  }
}
</script>

<h1 class="font-semibold text-2xl">New report</h1>

<p class="text-muted-foreground">
  Placeholder. The designed form arrives with the frontend; this one exists so the upload path can
  be used by hand.
</p>

<form class="flex w-full flex-col gap-4" onsubmit={handleSubmit}>
  <p>Uploading to <strong>{data.session?.organization.name ?? 'no organization'}</strong>.</p>

  <label class="flex flex-col gap-1">
    Report name
    <input
      class="border p-1"
      name={FIELD.name}
      maxlength={MAX_REPORT_NAME_LENGTH}
      autocomplete="off"
    >
  </label>

  <label class="flex flex-col gap-1">
    Site name (optional)
    <input class="border p-1" name={FIELD.siteName} maxlength={MAX_SITE_NAME_LENGTH}>
  </label>

  <label class="flex flex-col gap-1">
    Counts are
    <select class="border p-1" name={FIELD.countsBasis} required>
      {#each COUNTS_BASES as basis (basis)}
        <option value={basis}>{basis}</option>
      {/each}
    </select>
  </label>

  <label class="flex flex-col gap-1">
    Weights are in
    <select class="border p-1" name={FIELD.unitSystem} required>
      {#each UNIT_SYSTEMS as system (system)}
        <option value={system}>{system}</option>
      {/each}
    </select>
  </label>

  <label class="flex flex-col gap-1">
    Diners or meals per month, as JSON
    <textarea
      class="border p-1 font-mono"
      name={FIELD.monthlyCounts}
      rows="3"
      required
      value={'{"2026-01": 120, "2026-02": 135}'}
    ></textarea>
  </label>

  <label class="flex flex-col gap-1">
    Procurement CSV (up to {Math.floor(MAX_INPUT_FILE_BYTES / 1024 / 1024)}MB)
    <input class="border p-1" type="file" name={FIELD.file} accept={CSV_FILE_ACCEPT} required>
  </label>

  <button class="border px-3 py-1" type="submit" disabled={submission.status === 'submitting'}>
    {submission.status === 'submitting' ? 'Uploading…' : 'Upload'}
  </button>

  {#if submission.status === 'error'}
    <p role="alert" class="text-red-700">{submission.message}</p>
  {/if}
</form>
