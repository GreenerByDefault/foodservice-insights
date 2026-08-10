<script lang="ts">
import { describeError } from '$lib/errors/messages';

interface Props {
  status: number;
}

let { status }: Props = $props();

const presentation = $derived(describeError(status));
</script>

<svelte:head>
  <title>{presentation.title}</title>
  <!-- A failed request is not a page, so keep it out of the index and out of search results. -->
  <meta name="robots" content="noindex">
</svelte:head>

<!-- No calls to action yet, deliberately. Choosing them needs decisions we have not made: the 401
     becomes an inline sign-in form once auth lands, and the 5xx cases want a retry plus somewhere to
     report the failure. A per-failure id belongs with that last one — until a user is told to quote
     it, `handleError` finding its own log line by timestamp and user is enough. -->
<div class="flex flex-col items-start gap-3">
  <h1 class="text-3xl font-semibold tracking-tight">{presentation.title}</h1>
  <p class="max-w-prose text-muted-foreground">{presentation.body}</p>

  {#if presentation.showStatus}
    <p class="text-sm text-muted-foreground">Error {status}</p>
  {/if}
</div>
