<script lang="ts">
import * as Card from '$lib/components/ui/card';
import PageHeading from '$lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import InviteForm from './invite-form.svelte';
import MembersList from './members-list.svelte';
import PendingInvites from './pending-invites.svelte';
import YourMembership from './your-membership.svelte';

let { data }: PageProps = $props();

// Superadmins act on every organization as admin but hold no `organization_member` row of their
// own here, so there is nothing for "Your membership" to say to them.
let viewerUserId = $derived(data.members.find((member) => member.isYou)?.userId);
</script>

<PageHeading>Members</PageHeading>

<!-- Each part of the page — the roster, invites, and the viewer's own controls — gets its own
     Card so the eye can tell them apart at a glance, rather than relying on hairline separators
     to carry that weight between differently-shaped content. -->
<div class="space-y-6">
  <Card.Root>
    <Card.Content>
      <MembersList
        members={data.members}
        organizationSlug={data.organization.slug}
        viewerRole={data.role}
      />
    </Card.Content>
  </Card.Root>

  {#if data.invites}
    <Card.Root>
      <Card.Header>
        <Card.Title>Pending invitations</Card.Title>
      </Card.Header>
      <Card.Content>
        <PendingInvites invites={data.invites} organizationSlug={data.organization.slug} />
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Invite someone</Card.Title>
      </Card.Header>
      <Card.Content>
        <InviteForm organizationSlug={data.organization.slug} />
      </Card.Content>
    </Card.Root>
  {/if}

  {#if viewerUserId}
    <Card.Root>
      <Card.Header>
        <Card.Title>Your membership</Card.Title>
      </Card.Header>
      <Card.Content>
        <YourMembership
          organizationSlug={data.organization.slug}
          {viewerUserId}
          viewerRole={data.role}
        />
      </Card.Content>
    </Card.Root>
  {/if}
</div>
