<script lang="ts">
import { APP_NAME } from '@gbd/core';
import favicon from '#lib/assets/favicon.svg';
import { cn } from '#lib/utils/shadcn.js';

/** The app's name beside its mark, linking home. A text stand-in until GBD supplies a logo. */
interface Props {
  class?: string;
}

let { class: className }: Props = $props();
</script>

<!-- `/` is right for a signed-in visitor too: it redirects them to `/orgs`. -->
<a href="/" class={cn('flex shrink-0 items-center gap-2', className)}>
  <img src={favicon} alt="" class="size-6">
  <span class="font-heading text-lg font-medium text-heading">{APP_NAME}</span>
</a>
