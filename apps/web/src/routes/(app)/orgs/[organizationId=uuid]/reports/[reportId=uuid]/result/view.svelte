<script lang="ts">
import CircleCheckBigIcon from '@lucide/svelte/icons/circle-check-big';
import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import { formatElapsed, formatTimestamp } from '@gbd/core';
import { Button } from '$lib/components/ui/button/index.js';
import type { ResultFiles } from '../+page.server.ts';
import DeleteButton from '../delete-button.svelte';

interface Props {
  finishedAt: Date;
  now: Date;
  files: ResultFiles;
  inputFile: { href: string; originalFilename: string; byteSize: number };
  deleteButtonHref: string;
  organizationHref: string;
}

let { finishedAt, now, files, inputFile, deleteButtonHref, organizationHref }: Props = $props();
</script>

<div class="space-y-6">
  <div class="flex gap-3">
    <CircleCheckBigIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <p class="text-muted-foreground">
      Finished
      <time datetime={finishedAt.toISOString()} title={formatTimestamp(finishedAt)}
        >{formatElapsed(now, finishedAt)}</time
      >.
    </p>
  </div>

  <div class="flex flex-wrap gap-3">
    <Button href={files.pdf.href} variant="outline">
      <FileTextIcon aria-hidden="true" />
      Download PDF
    </Button>
    <Button href={files.xlsx.href} variant="outline">
      <FileSpreadsheetIcon aria-hidden="true" />
      Download Excel
    </Button>
    <DeleteButton {deleteButtonHref} {organizationHref} />
  </div>

  <div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>Uploaded file:</span>
    <a class="inline-flex items-center gap-1.5 underline hover:no-underline" href={inputFile.href}>
      <FileSpreadsheetIcon class="size-4 shrink-0" aria-hidden="true" />
      {inputFile.originalFilename}
    </a>
  </div>
</div>
