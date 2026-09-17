<script lang="ts">
import { Button } from '$lib/components/ui/button';
import RelativeTime from '$lib/components/relative-time.svelte';
import type { ActionState } from '$lib/forms/action-state';
import { revokeInvite } from '$lib/invites/api/revoke-invite';
import type { InviteRow } from './+page.server.ts';

/** One row of `pending-invites.svelte`'s list: the invite's own state, and its Revoke button.
 * No confirm dialog — re-inviting the same address supersedes and resends, so revoking the
 * wrong one costs nothing but a moment. */
interface Props {
  organizationSlug: string;
  invite: InviteRow;
  onRevoked: () => Promise<void>;
}

let { organizationSlug, invite, onRevoked }: Props = $props();

const ROLE_LABEL = { admin: 'Admin', member: 'Member' } as const;

let actionState = $state<ActionState>({ status: 'idle' });

async function revoke() {
  actionState = { status: 'loading' };
  try {
    await revokeInvite(organizationSlug, invite.inviteId);
    actionState = { status: 'idle' };
    await onRevoked();
  } catch {
    actionState = { status: 'error', message: "Couldn't revoke this invite — please try again." };
  }
}
</script>

<!-- `flex-wrap` + `basis-full` on the error message: same reason as members-list.svelte's own
     row — the message needs its own line without shifting what's already on this one. -->
<li class="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-2 py-3">
  <span
    class="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
  >
    <span class="min-w-0 truncate font-medium">{invite.email}</span>
    <span class="shrink-0 text-sm text-muted-foreground">
      {ROLE_LABEL[invite.role]}
      ·
      {#if invite.isExpired}
        Expired
      {:else}
        Expires <RelativeTime at={invite.expiresAt} now={invite.now} direction="future" />
      {/if}
    </span>
  </span>
  <Button
    variant="outline"
    size="sm"
    onclick={revoke}
    disabled={actionState.status === 'loading'}
    aria-busy={actionState.status === 'loading'}
    aria-label="Revoke invite for {invite.email}"
  >
    Revoke
  </Button>
  {#if actionState.status === 'error'}
    <p role="alert" class="basis-full text-sm text-destructive">{actionState.message}</p>
  {/if}
</li>
