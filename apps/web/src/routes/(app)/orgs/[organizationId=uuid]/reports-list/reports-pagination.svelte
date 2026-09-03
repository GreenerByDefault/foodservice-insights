<script lang="ts">
import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import { Button } from '$lib/components/ui/button';

interface Props {
  olderHref: string | null;
  newerHref: string | null;
}

let { olderHref, newerHref }: Props = $props();
</script>

{#if olderHref || newerHref}
  <nav aria-label="Reports pages" class="flex w-full items-center justify-between">
    <div>
      {#if newerHref}
        <Button href={newerHref} variant="ghost" size="sm">
          <ChevronLeftIcon class="size-4" aria-hidden="true" />
          Newer
        </Button>
      {/if}
    </div>
    <div>
      {#if olderHref}
        <Button href={olderHref} variant="ghost" size="sm">
          Older
          <ChevronRightIcon class="size-4" aria-hidden="true" />
        </Button>
      {/if}
    </div>
  </nav>
{/if}
