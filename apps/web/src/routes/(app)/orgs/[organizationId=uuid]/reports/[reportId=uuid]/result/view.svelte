<script lang="ts">
import type { ResultFiles } from '../+page.server.ts';

interface Props {
  finishedAt: Date;
  files: ResultFiles;
  inputFile: { href: string; originalFilename: string };
}

let { finishedAt, files, inputFile }: Props = $props();
</script>

<p class="text-muted-foreground">
  Finished
  <time datetime={finishedAt.toISOString()}>{finishedAt.toISOString()}</time>.
</p>
<ul>
  <li>
    <a class="underline hover:no-underline" href={files.pdf.href}> Download PDF </a>
  </li>
  <li>
    <a class="underline hover:no-underline" href={files.xlsx.href}> Download Excel </a>
  </li>
  {#each files.charts as chart (chart.href)}
    <li>
      <a class="underline hover:no-underline" href={chart.href}>{chart.chartKey}</a>
    </li>
  {/each}
</ul>
<p>
  <a class="underline hover:no-underline" href={inputFile.href}>
    {inputFile.originalFilename}
  </a>
</p>
