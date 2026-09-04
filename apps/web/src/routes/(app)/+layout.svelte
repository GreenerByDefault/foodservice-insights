<script lang="ts">
import { APP_NAME } from '@gbd/core';
import { page } from '$app/state';
import OrganizationSwitcher from './organization-switcher.svelte';
import type { LayoutProps } from './$types';
import UserMenu from './user-menu.svelte';

let { data, children }: LayoutProps = $props();

// Published by the layout under `orgs/[organizationId]`, which sits *below* this one. `page.data`
// is every load's data merged together, so the shell can read what a descendant resolved. Absent
// on the routes that act on no organization, such as `/account`.
const currentOrganization = $derived(page.data.organization);
</script>

<div class="flex min-h-svh flex-col">
  <header class="border-b">
    <div class="mx-auto flex w-full max-w-4xl items-center gap-3 px-6 py-3 sm:px-8">
      <a href="/" class="hidden shrink-0 text-sm font-medium text-muted-foreground sm:block">
        {APP_NAME}
      </a>

      <OrganizationSwitcher
        current={currentOrganization}
        organizations={data.organizations}
        hasMore={data.hasMoreOrganizations}
      />

      <div class="ml-auto">
        <UserMenu email={data.user.email} displayName={data.user.displayName} />
      </div>
    </div>
  </header>

  <main class="mx-auto flex w-full max-w-4xl flex-1 flex-col items-start gap-4 px-6 py-8 sm:px-8">
    {@render children()}
  </main>
</div>
