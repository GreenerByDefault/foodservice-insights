<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import * as Field from '$lib/components/ui/field';
import type { PageProps } from './$types';
import MembersList from './members-list.svelte';
import YourMembership from './your-membership.svelte';

let { data }: PageProps = $props();

// Superadmins act on every organization as admin but hold no `organization_member` row of their
// own here, so there is nothing for "Your membership" to say to them.
let viewerUserId = $derived(data.members.find((member) => member.isYou)?.userId);
</script>

<PageHeading>Members</PageHeading>

<MembersList
  members={data.members}
  organizationSlug={data.organization.slug}
  viewerRole={data.role}
/>

{#if viewerUserId}
  <Field.Separator />

  <YourMembership organizationSlug={data.organization.slug} {viewerUserId} viewerRole={data.role} />
{/if}
