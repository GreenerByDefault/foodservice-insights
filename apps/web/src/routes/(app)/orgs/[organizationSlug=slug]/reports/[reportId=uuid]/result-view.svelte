<script lang="ts">
import CircleCheckBigIcon from '@lucide/svelte/icons/circle-check-big';
import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import { Button } from '#lib/components/ui/button/index.js';
import RelativeTime from '#lib/components/relative-time.svelte';
import type { ResultFiles } from './+page.server.ts';
import DeleteButton from './delete-button.svelte';
import StatusLine from './status-line.svelte';

interface Props {
  finishedAt: Date;
  now: Date;
  files: ResultFiles;
  organizationSlug: string;
  reportId: string;
  reportName: string;
}

let { finishedAt, now, files, organizationSlug, reportId, reportName }: Props = $props();
</script>

<div class="space-y-6">
  <StatusLine icon={CircleCheckBigIcon} iconClass="text-primary">
    <p class="text-muted-foreground">
      Finished <RelativeTime at={finishedAt} {now} direction="past" />.
    </p>
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
    <DeleteButton {organizationSlug} {reportId} {reportName} />
  </div>
</div>
