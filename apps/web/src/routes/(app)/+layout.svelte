<script lang="ts">
import { page } from '$app/state';
import OrganizationSwitcher from './organization-switcher.svelte';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

// Published by the layout under `orgs/[organizationId]`, which sits *below* this one. `page.data`
// is every load's data merged together, so the shell can read what a descendant resolved. Absent
// on the routes that act on no organization, such as `/account`.
const currentOrganization = $derived(page.data.organization);
</script>

<div class="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 p-8">
  <header
    class="flex flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
  >
    <OrganizationSwitcher current={currentOrganization} organizations={data.organizations} />

    <!-- Signing out is a browser-side Supabase call, so it will arrives as a component with the rest of
         auth, rather than as a link to a route. -->

    <a class="min-w-0 truncate text-muted-foreground hover:text-foreground" href="/account">
      {data.auth.user.email}
    </a>
  </header>

  <main class="flex flex-1 flex-col items-start gap-4">
    {@render children()}
  </main>
</div>
