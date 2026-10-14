<script lang="ts">
import { APP_NAME } from '@gbd/core';
import { page } from '$app/state';
import { authMode } from '#lib/auth/mode.js';
import SiteHeader from '#lib/components/site-header.svelte';
import type { LayoutProps } from './$types';
import OrganizationSwitcher from './shell/organization-switcher.svelte';
import UserMenu from './shell/user-menu.svelte';

let { data, children }: LayoutProps = $props();

// Published by the layout under `orgs/[organizationSlug]`, which sits *below* this one. `page.data`
// is every load's data merged together, so the shell can read what a descendant resolved. Absent
// on the routes that act on no organization, such as `/account`.
const currentOrganization = $derived(page.data.organization);
</script>

<div class="flex min-h-svh flex-col">
  <SiteHeader>
    <a href="/" class="hidden shrink-0 text-sm font-medium text-muted-foreground sm:block">
      {APP_NAME}
    </a>

    <!-- Mobile hides the app title, so the switcher sits first and reads as the page's
         identity; sm+ shows the title and groups the switcher with the avatar instead. -->
    <div class="min-w-0 sm:ml-auto">
      <OrganizationSwitcher
        current={currentOrganization}
        organizations={data.organizations}
        hasMore={data.hasMoreOrganizations}
      />
    </div>

    <div class="ml-auto sm:ml-0">
      <UserMenu email={data.user.email} displayName={data.user.displayName} mode={authMode()} />
    </div>
  </SiteHeader>

  <!-- Lists span this full width; a form caps itself at `max-w-md`. `items-start` shrinks a child
       to its content, so a page's wrapper needs `w-full` or its width varies with its data. -->
  <!-- No skip link for now: only two focusable elements precede this on a phone, three on
       desktop. Add one if the header grows. -->
  <main class="page-width flex flex-1 flex-col items-start gap-4 py-8">
    {@render children()}
  </main>
</div>
