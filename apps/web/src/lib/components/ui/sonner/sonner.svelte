<script lang="ts">
// The one toaster, mounted in the root layout so a toast survives a navigation. Raise one with
// `toast.success(...)` from `svelte-sonner`. When to:
//
// 1. Toast success only when the outcome isn't obvious where the user is looking, including when
//    a navigation takes away the context. Don't toast when the new page is itself the
//    confirmation (sign-in, create org, upload report, cancel, retry).
// 2. Errors stay inline: the existing messages persist and carry recovery instructions, and a
//    toast would time out before they're read. The exception is a failure with no inline place.
// 3. Toast only after the refresh or navigation resolves (`await onDone()`, `refreshAll()`,
//    `goto()`), so it never claims success before the page reflects it.
// 4. Copy names the thing: "Deleted Acme Foodservice", not "Success".
import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';
import Loader2Icon from '@lucide/svelte/icons/loader-2';
import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
import InfoIcon from '@lucide/svelte/icons/info';
import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
  theme="light"
  class="toaster group"
  style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
  {...restProps}
>
  {#snippet loadingIcon()}
    <Loader2Icon class="size-4 animate-spin" />
  {/snippet}
  {#snippet successIcon()}
    <CircleCheckIcon class="size-4" />
  {/snippet}
  {#snippet errorIcon()}
    <OctagonXIcon class="size-4" />
  {/snippet}
  {#snippet infoIcon()}
    <InfoIcon class="size-4" />
  {/snippet}
  {#snippet warningIcon()}
    <TriangleAlertIcon class="size-4" />
  {/snippet}
</Sonner>
