<script lang="ts">
import { cn, type WithElementRef } from '$lib/utils/shadcn.js';
import type { HTMLAttributes } from 'svelte/elements';

let {
  ref = $bindable(null),
  class: className,
  children,
  ...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<!-- `aria-hidden`, which shadcn generates without: the cells are a picture of the value that the
     sibling `<input>` already carries, and left in the accessibility tree they read as loose text
     beside the field, one digit at a time. -->
<div
  bind:this={ref}
  data-slot="input-otp-group"
  aria-hidden="true"
  class={cn("has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40 has-aria-invalid:border-destructive rounded-md has-aria-invalid:ring-3 flex items-center", className)}
  {...restProps}
>
  {@render children?.()}
</div>
