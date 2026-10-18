<script lang="ts">
import { cn, type WithElementRef } from '#lib/utils/shadcn.js';
import type { HTMLFieldsetAttributes } from 'svelte/elements';

let {
  ref = $bindable(null),
  class: className,
  children,
  ...restProps
}: WithElementRef<HTMLFieldsetAttributes> = $props();
</script>

<!-- `min-w-0` undoes the browser's `min-inline-size: min-content` on a fieldset, which otherwise
     grows to fit a long unbroken string, such as a file name, instead of letting `truncate`
     inside it work. -->
<fieldset
  bind:this={ref}
  data-slot="field-set"
  class={cn(
    'min-w-0 gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3 flex flex-col',
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</fieldset>
