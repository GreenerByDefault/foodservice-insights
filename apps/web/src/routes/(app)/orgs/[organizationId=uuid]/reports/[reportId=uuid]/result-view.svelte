<script lang="ts">
import CircleCheckBigIcon from '@lucide/svelte/icons/circle-check-big';
import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import { Button } from '$lib/components/ui/button';
import RelativeTime from '$lib/components/reports/relative-time.svelte';
import type { DeleteAction, ResultFiles } from './+page.server.ts';
import DeleteButton from './delete-button.svelte';
import StatusLine from './status-line.svelte';

interface Props {
  finishedAt: Date;
  now: Date;
  files: ResultFiles;
  inputFile: { href: string; originalFilename: string; byteSize: number };
  deleteAction: DeleteAction;
}

let { finishedAt, now, files, inputFile, deleteAction }: Props = $props();
</script>

<div class="space-y-6">
  <StatusLine icon={CircleCheckBigIcon}>
    <p class="text-muted-foreground">Finished <RelativeTime at={finishedAt} {now} />.</p>
  </StatusLine>

  <div class="flex flex-wrap gap-3">
    <Button href={files.pdf.href} variant="outline">
      <FileTextIcon aria-hidden="true" />
      Download PDF
    </Button>
    <Button href={files.xlsx.href} variant="outline">
      <FileSpreadsheetIcon aria-hidden="true" />
      Download Excel
    </Button>
    <DeleteButton action={deleteAction} />
  </div>

  <div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>Uploaded file:</span>
    <a
      class="inline-flex min-w-0 items-center gap-1.5 underline hover:no-underline"
      href={inputFile.href}
    >
      <FileSpreadsheetIcon class="size-4 shrink-0" aria-hidden="true" />
      <span class="truncate">{inputFile.originalFilename}</span>
    </a>
  </div>
</div>
