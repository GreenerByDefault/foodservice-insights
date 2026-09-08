<script lang="ts">
import LogOutIcon from '@lucide/svelte/icons/log-out';
import UserIcon from '@lucide/svelte/icons/user';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import { Button } from '$lib/components/ui/button';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { cnChildProps } from '$lib/utils/shadcn.js';
import { initials } from './initials.ts';

interface Props {
  email: string;
  displayName: string | null;
}

let { email, displayName }: Props = $props();

const monogram = $derived(initials(displayName));
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
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
      {#snippet child({ props })}
        <a {...props} href="/account" class={cnChildProps(props, 'flex items-center gap-2')}>
          <UserIcon class="size-4 shrink-0" />
          Account
        </a>
      {/snippet}
    </DropdownMenu.Item>

    <DropdownMenu.Separator class="my-2" />

    <!-- **Stub:** signing out is a browser-side `supabase.auth.signOut()` followed by
         `invalidateAll()`, arriving with the rest of auth. No route of ours is involved. -->
    <DropdownMenu.Item disabled class="flex items-center gap-2 px-3 py-2">
      <LogOutIcon class="size-4 shrink-0" />
      Sign out
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
