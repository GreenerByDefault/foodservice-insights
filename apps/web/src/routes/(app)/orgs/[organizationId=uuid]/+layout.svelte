<script lang="ts">
import { page } from '$app/state';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

const root = $derived(`/orgs/${data.organization.id}`);

function currentSection(pathname: string, organizationRoot: string) {
  if (pathname.startsWith(`${organizationRoot}/members`)) return 'members';
  if (pathname.startsWith(`${organizationRoot}/settings`)) return 'settings';
  // Reports live at the organization's root rather than under `reports/`, so this tab owns the
  // root itself as well as everything beneath `reports/`.
  return 'reports';
}

const section = $derived(currentSection(page.url.pathname, root));
</script>

<!-- The organization's sections. -->
<nav class="flex gap-4 border-b pb-2 text-sm" aria-label="Organization">
  <a href={root} aria-current={section === 'reports' ? 'page' : undefined}>Reports</a>
  <a href="{root}/members" aria-current={section === 'members' ? 'page' : undefined}>Members</a>
  <a href="{root}/settings" aria-current={section === 'settings' ? 'page' : undefined}>Settings</a>
</nav>

{@render children()}
