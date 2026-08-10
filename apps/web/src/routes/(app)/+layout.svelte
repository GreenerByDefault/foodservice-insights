<script lang="ts">
import { page } from '$app/state';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

// Published by the layout under `orgs/[organizationId]`, which sits *below* this one. `page.data`
// is every load's data merged together, so the shell can read what a descendant resolved. Absent
// on the routes that act on no organization, such as `/account`.
const currentOrganization = $derived(page.data.organization);
</script>

<div class="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 p-8">
  <header class="flex items-baseline justify-between gap-4 text-sm">
    <details class="relative">
      <summary class="cursor-pointer font-medium">
        {currentOrganization?.name ?? 'Choose an organization'}
      </summary>

      <ul class="absolute left-0 z-10 mt-2 min-w-56 rounded-md border bg-background p-1 shadow-md">
        {#each data.auth.organizations as organization (organization.organizationId)}
          <li>
            <a
              class="block rounded-sm px-2 py-1 hover:bg-muted"
              href="/orgs/{organization.organizationId}"
            >
              {organization.organizationName}
            </a>
          </li>
        {/each}
        <li>
          <a class="block rounded-sm px-2 py-1 hover:bg-muted" href="/orgs/new">
            New organization
          </a>
        </li>
      </ul>
    </details>

    <!-- Signing out is a browser-side Supabase call, so it will arrives as a component with the rest of
         auth, rather than as a link to a route. -->

    <a class="text-muted-foreground hover:text-foreground" href="/account">
      {data.auth.user.email}
    </a>
  </header>

  <main class="flex flex-1 flex-col items-start gap-4">
    {@render children()}
  </main>
</div>
