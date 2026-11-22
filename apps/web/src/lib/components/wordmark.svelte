<script lang="ts">
import { APP_NAME } from '@gbd/core';
import mark from '#lib/assets/mark.svg';
import { cn } from '#lib/utils/shadcn.js';

/** The app's name beside its mark, linking home. Our own mark in GBD's style until GBD supplies one. */
interface Props {
  class?: string;
}

let { class: className }: Props = $props();
</script>

<!-- `/` is right for a signed-in visitor too: it redirects them to `/orgs`. -->
<a href="/" class={cn('flex shrink-0 items-center gap-2.5', className)}>
  <img src={mark} alt="" width="46" height="28" class="h-7 w-auto">
  <span class="font-heading text-xl font-bold tracking-tight text-heading">{APP_NAME}</span>
</a>
