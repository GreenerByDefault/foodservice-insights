<script lang="ts">
import type { LucideIcon } from '@lucide/svelte';
import type { Snippet } from 'svelte';
import { cn } from '#lib/utils/shadcn.js';

interface Props {
  /** Decorative — every settled view states its status in the prose beside it, and the live
   * region in `report-view.svelte` is what announces a change. */
  icon: LucideIcon;
  /** Recolors the icon, which is muted by default. */
  iconClass?: string;
  children: Snippet;
}

let { icon: Icon, iconClass, children }: Props = $props();
</script>

<div class="flex gap-3">
  <!-- mt-0.5 nudges the glyph onto the first line's baseline; shrink-0 keeps it square when the
  prose beside it wraps. -->
  <Icon class={cn('mt-0.5 size-4 shrink-0 text-muted-foreground', iconClass)} aria-hidden="true" />
  {@render children()}
</div>
