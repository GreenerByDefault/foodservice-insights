<script lang="ts">
import LogOutIcon from '@lucide/svelte/icons/log-out';
import MailIcon from '@lucide/svelte/icons/mail';
import UserIcon from '@lucide/svelte/icons/user';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { browserAuth } from '#lib/auth/browser.js';
import type { AuthMode } from '#lib/auth/mode.js';
import { signOutOfSite } from '#lib/auth/site-session.js';
import { Button } from '#lib/components/ui/button/index.js';
import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
import { cnChildProps } from '#lib/utils/shadcn.js';
import { initials } from './initials.ts';

interface Props {
  email: string;
  displayName: string;
  mode: AuthMode;
}

let { email, displayName, mode }: Props = $props();

const monogram = $derived(initials(displayName));

async function signOut() {
  try {
    if (mode === 'supabase') {
      // `local`: this device only, leaving the user's other browsers signed in. Its error is not
      // checked: auth-js clears this device's session even when GoTrue refuses to revoke it, and in
      // the rare case it keeps one — it could not read the session at all — `/` redirects a
      // signed-in visitor back to `/orgs`, so nobody is left looking signed out who is not.
      await browserAuth().signOut({ scope: 'local' });
    } else {
      await signOutOfSite();
    }
  } catch (cause) {
    // Nothing was signed out. The Supabase seam rejects, rather than answering `{ error }`, only
    // when the client itself could not load, and the site session's cookie is cleared only by a
    // 2xx. So there is nowhere to go; the next click tries again.
    console.error('Could not sign out', cause);
    toast.error("Couldn't sign out. Try again.");
    return;
  }
  await goto('/', { refreshAll: true });
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
      <span class="truncate font-medium">{displayName}</span>
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

    <DropdownMenu.Separator class="my-2" />

    <DropdownMenu.Item onSelect={signOut} class="flex items-center gap-2 px-3 py-2">
      <LogOutIcon class="size-4 shrink-0" />
      Sign out
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
