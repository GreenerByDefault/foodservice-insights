<script lang="ts">
import { useFileDropZone } from './file-drop-zone.svelte.js';
import type { FileDropZoneRootProps } from './types.js';
import { box } from 'svelte-toolbelt';

const uid = $props.id();
let {
  ref = $bindable(null),
  id = uid,
  maxFiles,
  maxFileSize,
  fileCount,
  disabled = false,
  onUpload,
  onFileRejected,
  accept,
  children,
  ...rest
}: FileDropZoneRootProps = $props();

const rootState = useFileDropZone({
  id: box.with(() => id),
  disabled: box.with(() => disabled ?? false),
  onUpload: box.with(() => onUpload),
  maxFiles: box.with(() => maxFiles),
  fileCount: box.with(() => fileCount),
  maxFileSize: box.with(() => maxFileSize),
  onFileRejected: box.with(() => onFileRejected),
  accept: box.with(() => accept),
});
</script>

<!-- Visually hidden rather than `hidden`, so it stays in the tab order: Enter or Space on a file
     input opens the picker, and the trigger label shows the focus ring via `peer`. -->
<input bind:this={ref} class="peer sr-only" {...rootState.props} {...rest}>

{@render children?.()}
