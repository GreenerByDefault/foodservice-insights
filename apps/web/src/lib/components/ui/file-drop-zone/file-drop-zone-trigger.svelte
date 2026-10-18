<script lang="ts">
import { cn } from '#lib/utils/shadcn.js';
import { useFileDropZoneTrigger } from './file-drop-zone.svelte.js';
import type { FileDropZoneTriggerProps } from './types.js';
import UploadIcon from '@lucide/svelte/icons/upload';

let {
  ref = $bindable(null),
  class: className,
  label,
  children,
  ...rest
}: FileDropZoneTriggerProps = $props();

const triggerState = useFileDropZoneTrigger();
</script>

<label
  bind:this={ref}
  class={cn(
    'group/file-drop-zone-trigger block rounded-md peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
    className,
  )}
  {...triggerState.props}
  {...rest}
>
  {#if children}
    {@render children()}
  {:else}
    <div
      class="flex w-full flex-col place-items-center justify-center gap-2 rounded-md border border-dashed border-input bg-background px-3 py-8 transition-[color,background-color,border-color] group-aria-disabled/file-drop-zone-trigger:opacity-50 hover:cursor-pointer hover:border-ring hover:bg-accent/30 group-aria-disabled/file-drop-zone-trigger:hover:cursor-not-allowed dark:bg-input/30"
    >
      <div
        class="flex size-14 place-items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"
      >
        <UploadIcon class="size-7" />
      </div>
      <span class="text-center font-medium text-muted-foreground">{label}</span>
    </div>
  {/if}
</label>
