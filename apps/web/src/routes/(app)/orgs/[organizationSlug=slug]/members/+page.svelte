<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import MembersList from './members-list.svelte';

let { data }: PageProps = $props();
</script>

<PageHeading>Members</PageHeading>

<MembersList
  members={data.members}
  organizationSlug={data.organization.slug}
  viewerRole={data.role}
/>

{#if data.role === 'admin'}
  <p class="w-full text-sm text-muted-foreground">Inviting and removing people arrives later.</p>
{/if}
