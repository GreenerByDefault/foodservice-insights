<script lang="ts">
import ClockIcon from '@lucide/svelte/icons/clock';
import { toast } from 'svelte-sonner';
import { goto, refreshAll } from '$app/navigation';
import RelativeTime from '#lib/components/relative-time.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import * as Card from '#lib/components/ui/card/index.js';
import { organizationHref } from '#lib/hrefs.js';
import { acceptInvite } from '#lib/invites/api/accept-invite.js';
import { declineInvite } from '#lib/invites/api/decline-invite.js';
import { focusPageHeading } from '#lib/utils/focus-page-heading.js';
import type { InviteOffer } from './+page.server.ts';

interface Props {
  invite: InviteOffer;
}

let { invite }: Props = $props();

const ROLE_PHRASE = { admin: 'an admin', member: 'a member' } as const;

/** Which button is waiting on the server, so only that one shows as busy — both are disabled. */
let pending = $state<'accept' | 'decline' | null>(null);
let errorMessage = $state<string | null>(null);

async function accept() {
  pending = 'accept';
  errorMessage = null;
  const outcome = await acceptInvite(invite.inviteId);
  switch (outcome.kind) {
    case 'accepted':
      // Left pending: this card unmounts with the navigation.
      await goto(organizationHref(outcome.organizationSlug), { refreshAll: true });
      toast.success(`You joined ${invite.organizationName}`);
      return;
    // The list is stale — it ran out, or was revoked or superseded, since the page loaded. The
    // reload shows it expired, or gone, which says so better than an error would.
    case 'expired':
    case 'no-longer-valid':
      await refreshAll();
      break;
    case 'unknown':
      errorMessage = "Couldn't accept this invitation — please try again.";
      break;
  }
  pending = null;
}

async function decline() {
  pending = 'decline';
  errorMessage = null;
  const outcome = await declineInvite(invite.inviteId);
  if (outcome.kind === 'unknown') {
    errorMessage = invite.isExpired
      ? "Couldn't dismiss this invitation — please try again."
      : "Couldn't decline this invitation — please try again.";
  } else {
    await refreshAll();
    await focusPageHeading();
    toast.success(
      invite.isExpired
        ? `Dismissed the invitation to ${invite.organizationName}`
        : `Declined the invitation to ${invite.organizationName}`,
    );
  }
  pending = null;
}
</script>

<li>
  <Card.Root class={invite.isExpired ? 'bg-muted/40 shadow-none' : ''}>
    <Card.Content class="gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 flex-col gap-1">
        <!-- Wraps rather than truncating: the organization's name is what the invitee is deciding on. -->
        <h2
          class={['text-base font-medium break-words', invite.isExpired && 'text-muted-foreground']}
        >
          {invite.organizationName}
        </h2>
        {#if invite.isExpired}
          <p class="text-muted-foreground">
            Your invitation expired
            <RelativeTime at={invite.expiresAt} now={invite.now} direction="past" />. Ask an admin
            there to send a new one.
          </p>
        {:else}
          <p>
            {invite.invitedByName ?? 'An admin'}
            invited you to join as {ROLE_PHRASE[invite.role]}.
          </p>
          <p class="flex items-center gap-1.5 text-muted-foreground">
            <ClockIcon class="size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Expires <RelativeTime at={invite.expiresAt} now={invite.now} direction="future" />
            </span>
          </p>
        {/if}
      </div>

      <!-- A two-column grid on a phone, so each button is a full half-width target. -->
      <div class={['grid shrink-0 gap-2 sm:flex', !invite.isExpired && 'grid-cols-2']}>
        {#if invite.isExpired}
          <Button
            variant="outline"
            onclick={decline}
            disabled={pending !== null}
            aria-busy={pending === 'decline'}
            aria-label="Dismiss invitation to {invite.organizationName}"
          >
            Dismiss
          </Button>
        {:else}
          <Button
            variant="outline"
            onclick={decline}
            disabled={pending !== null}
            aria-busy={pending === 'decline'}
            aria-label="Decline invitation to {invite.organizationName}"
          >
            Decline
          </Button>
          <Button
            onclick={accept}
            disabled={pending !== null}
            aria-busy={pending === 'accept'}
            aria-label="Accept invitation to {invite.organizationName}"
          >
            Accept
          </Button>
        {/if}
      </div>
    </Card.Content>

    {#if errorMessage}
      <Card.Footer>
        <p role="alert" class="text-sm text-destructive">{errorMessage}</p>
      </Card.Footer>
    {/if}
  </Card.Root>
</li>
