<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import InviteDialog from './invite-dialog.svelte';
import MembersList from './members-list.svelte';
import PendingInvites from './pending-invites.svelte';
import YourMembership from './your-membership.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();

// Superadmins act on every organization as admin but hold no `organization_member` row of their
// own here, so there is nothing for "Your membership" to say to them.
let viewerUserId = $derived(data.members.find((member) => member.isYou)?.userId);
</script>

<svelte:head>
  <title>{pageTitle('Organization members', data.organization.name)}</title>
</svelte:head>

<PageHeading>
  Organization members
  {#snippet actions()}
    {#if data.invites}
      <InviteDialog
        organizationSlug={data.organization.slug}
        organizationName={data.organization.name}
      />
    {/if}
  {/snippet}
</PageHeading>

<div class="flex w-full flex-col gap-10">
  <MembersList
    members={data.members}
    organizationSlug={data.organization.slug}
    viewerRole={data.role}
  />

  {#if data.invites}
    <section class="flex flex-col gap-3">
      <h2 class="text-lg font-medium">Pending invitations</h2>
      <PendingInvites invites={data.invites} organizationSlug={data.organization.slug} />
    </section>
  {/if}

  {#if viewerUserId}
    <section class="flex flex-col gap-3">
      <h2 class="text-lg font-medium">Your membership</h2>
      <YourMembership
        organizationSlug={data.organization.slug}
        {viewerUserId}
        viewerRole={data.role}
        organizationName={data.organization.name}
      />
    </section>
  {/if}
</div>
