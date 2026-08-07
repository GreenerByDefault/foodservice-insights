<script lang="ts">
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

// Phase one has exactly one organization. When a user can belong to several, this becomes the
// switcher REQUIREMENTS.md describes, reading the active one off the request rather than the list.
const organizationName = $derived(data.auth.memberships[0]?.organizationName ?? 'No organization');
</script>

<!-- The page shell lives here rather than in the root layout, so the header is a sibling of
     `<main>` and keeps its `banner` role. -->
<div class="mx-auto flex min-h-svh max-w-2xl flex-col gap-4 p-8">
  <header class="flex items-baseline justify-between gap-4 text-sm">
    <span class="font-medium">{organizationName}</span>
    <span class="text-muted-foreground">{data.auth.user.email}</span>
  </header>

  <main class="flex flex-1 flex-col items-start justify-center gap-4">
    {@render children()}
  </main>
</div>
