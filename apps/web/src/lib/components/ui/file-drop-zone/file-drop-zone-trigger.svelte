<script lang="ts">
import { cn } from '$lib/utils/shadcn.js';
import { useFileDropZoneTrigger } from './file-drop-zone.svelte.js';
import { displaySize } from './index.js';
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
  class={cn('group/file-drop-zone-trigger', className)}
  {...triggerState.props}
  {...rest}
>
  {#if children}
    {@render children()}
  {:else}
    <div
      class="flex aspect-video w-full flex-col place-items-center justify-center gap-2 rounded-md border border-dashed border-input bg-background px-3 py-6 transition-[color,background-color,border-color] group-aria-disabled/file-drop-zone-trigger:opacity-50 hover:cursor-pointer hover:border-ring hover:bg-accent/30 group-aria-disabled/file-drop-zone-trigger:hover:cursor-not-allowed dark:bg-input/30"
    >
      <div
        class="flex size-14 place-items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"
      >
        <UploadIcon class="size-7" />
      </div>
      <div class="flex flex-col gap-0.5 text-center">
        <span class="font-medium text-muted-foreground">
          {label}
        </span>
        {#if triggerState.rootState.opts.maxFiles.current || triggerState.rootState.opts.maxFileSize.current}
          <span class="text-sm text-muted-foreground/75">
            {#if triggerState.rootState.opts.maxFiles.current}
              <span> You can upload {triggerState.rootState.opts.maxFiles.current} files </span>
            {/if}
            {#if triggerState.rootState.opts.maxFiles.current && triggerState.rootState.opts.maxFileSize.current}
              <span>
                (up to {displaySize(triggerState.rootState.opts.maxFileSize.current)} each)
              </span>
            {/if}
            {#if triggerState.rootState.opts.maxFileSize.current && !triggerState.rootState.opts.maxFiles.current}
              <span>
                Maximum size {displaySize(triggerState.rootState.opts.maxFileSize.current)}
              </span>
            {/if}
          </span>
        {/if}
      </div>
    </div>
  {/if}
</label>
