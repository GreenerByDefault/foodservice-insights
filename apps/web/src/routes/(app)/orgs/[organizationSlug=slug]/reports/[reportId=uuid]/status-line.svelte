<script lang="ts">
import type { LucideIcon } from '@lucide/svelte';
import type { Snippet } from 'svelte';

interface Props {
  /** Decorative — every settled view states its status in the prose beside it, and the live
   * region in `report-view.svelte` is what announces a change. */
  icon: LucideIcon;
  children: Snippet;
}

let { icon: Icon, children }: Props = $props();
</script>

<div class="flex gap-3">
  <!-- mt-0.5 nudges the glyph onto the first line's baseline; shrink-0 keeps it square when the
  prose beside it wraps. -->
  <Icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  {@render children()}
</div>
