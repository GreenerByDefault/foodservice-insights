<script lang="ts">
import { invalidateAll } from '$app/navigation';
import ItemList from '$lib/components/item-list.svelte';
import type { InviteRow } from './+page.server.ts';
import PendingInviteRow from './pending-invite-row.svelte';

interface Props {
  invites: readonly InviteRow[];
  organizationSlug: string;
}

let { invites, organizationSlug }: Props = $props();
</script>

<ItemList items={invites} key={(invite) => invite.inviteId} empty="No pending invitations.">
  {#snippet children(invite)}
    <PendingInviteRow {organizationSlug} {invite} onRevoked={invalidateAll} />
  {/snippet}
</ItemList>
