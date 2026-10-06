<script lang="ts">
import MailOpenIcon from '@lucide/svelte/icons/mail-open';
import { Button } from '#lib/components/ui/button/index.js';
import * as Card from '#lib/components/ui/card/index.js';
import type { InviteOffer as InviteOfferRow } from './+page.server.ts';
import InviteOffer from './invite-offer.svelte';

interface Props {
  invites: readonly InviteOfferRow[];
}

let { invites }: Props = $props();
</script>

{#if invites.length === 0}
  <Card.Root class="w-full">
    <Card.Content class="items-center gap-4 py-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-full bg-muted">
        <MailOpenIcon class="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <div class="flex flex-col gap-1">
        <p class="text-base font-medium">No invitations waiting.</p>
        <p class="text-muted-foreground">
          When an admin invites you to an organization, it'll show up here.
        </p>
      </div>
      <Button variant="outline" href="/orgs">Go to your organizations</Button>
    </Card.Content>
  </Card.Root>
{:else}
  <ul class="flex w-full flex-col gap-4">
    {#each invites as invite (invite.inviteId)}
      <InviteOffer {invite} />
    {/each}
  </ul>
{/if}
