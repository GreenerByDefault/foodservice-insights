<script lang="ts">
import { page } from '$app/state';
import { organizationHref, organizationMembersHref, organizationSettingsHref } from '$lib/hrefs';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();

/** Root first, then each nested section — `currentSection` relies on that order. */
const sections = $derived([
  { label: 'Reports', href: organizationHref(data.organization.id) },
  { label: 'Members', href: organizationMembersHref(data.organization.id) },
  { label: 'Settings', href: organizationSettingsHref(data.organization.id) },
]);

/** The most specific section the path falls under. Reports live at the organization's root rather
 * than under `reports/`, so its href prefixes every other section's — the last match wins. */
const currentSection = $derived(
  sections.filter((section) => page.url.pathname.startsWith(section.href)).at(-1),
);
</script>

<!-- The organization's sections. -->
<nav class="flex gap-4 border-b pb-2 text-sm" aria-label="Organization">
  {#each sections as section (section.href)}
    <a href={section.href} aria-current={section === currentSection ? 'page' : undefined}>
      {section.label}
    </a>
  {/each}
</nav>

{@render children()}
