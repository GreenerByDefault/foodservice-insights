<script lang="ts">
import LogOutIcon from '@lucide/svelte/icons/log-out';
import MailIcon from '@lucide/svelte/icons/mail';
import UserIcon from '@lucide/svelte/icons/user';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { browserAuth } from '$lib/auth/browser';
import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { cnChildProps } from '$lib/utils/shadcn.js';
import { initials } from './initials.ts';

interface Props {
  email: string;
  displayName: string | null;
  /** False in `placeholder` mode, which has no session to end. */
  canSignOut: boolean;
}

let { email, displayName, canSignOut }: Props = $props();

const monogram = $derived(initials(displayName));

async function signOut() {
  // `local`: this device only, leaving the user's other browsers signed in. Its error is not
  // checked: auth-js clears this device's session even when GoTrue refuses to revoke it, and in the
  // rare case it keeps one — it could not read the session at all — `/` redirects a signed-in
  // visitor back to `/orgs`, so nobody is left looking signed out who is not.
  try {
    await browserAuth().signOut({ scope: 'local' });
  } catch (cause) {
    // The seam rejects, rather than answering `{ error }`, when the client itself could not load.
    // Nothing was signed out, so there is nowhere to go; the next click loads it afresh.
    console.error('Could not sign out', cause);
    toast.error("Couldn't sign out. Try again.");
    return;
  }
  await goto('/', { invalidateAll: true });
}
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({
      props,
    })}
      <Button
        {...props}
        variant="secondary"
        size="icon"
        class={cnChildProps(props, 'rounded-full')}
      >
        {#if monogram}
          <span class="text-xs font-medium">{monogram}</span>
        {:else}
          <UserRoundIcon class="size-4" />
        {/if}
        <span class="sr-only">Account menu</span>
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="end" class="w-64 p-2">
    <DropdownMenu.Label class="flex flex-col gap-0.5 px-2 py-1.5 text-sm text-foreground">
      {#if displayName}
        <span class="truncate font-medium">{displayName}</span>
      {/if}
      <span class="truncate text-muted-foreground">{email}</span>
    </DropdownMenu.Label>

    <DropdownMenu.Separator class="my-2" />

    <DropdownMenu.Item class="px-3 py-2">
      {#snippet child({
        props,
      })}
        <a {...props} href="/account" class={cnChildProps(props, 'flex items-center gap-2')}>
          <UserIcon class="size-4 shrink-0" />
          Account
        </a>
      {/snippet}
    </DropdownMenu.Item>

    <DropdownMenu.Item class="px-3 py-2">
      {#snippet child({
        props,
      })}
        <a {...props} href="/invites" class={cnChildProps(props, 'flex items-center gap-2')}>
          <MailIcon class="size-4 shrink-0" />
          Invitations
        </a>
      {/snippet}
    </DropdownMenu.Item>

    {#if canSignOut}
      <DropdownMenu.Separator class="my-2" />

      <DropdownMenu.Item onSelect={signOut} class="flex items-center gap-2 px-3 py-2">
        <LogOutIcon class="size-4 shrink-0" />
        Sign out
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
