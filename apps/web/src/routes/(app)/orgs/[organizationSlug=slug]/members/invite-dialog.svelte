<script lang="ts">
import { INVITE_LIFETIME_DAYS } from '@gbd/core';
import { buttonVariants } from '#lib/components/ui/button/index.js';
import * as Dialog from '#lib/components/ui/dialog/index.js';
import InviteForm from './invite-form.svelte';

interface Props {
  organizationSlug: string;
  organizationName: string;
}

let { organizationSlug, organizationName }: Props = $props();

let open = $state(false);
let submitting = $state(false);

// Closing mid-request would unmount the form before its outcome arrives, so a failure would be
// shown to nobody.
function keepOpenWhileSubmitting(event: Event) {
  if (submitting) event.preventDefault();
}
</script>

<!-- The form lives inside `Dialog.Content`, which unmounts on close, so every open starts with an
     empty form and no message. -->
<Dialog.Root bind:open>
  <Dialog.Trigger class={buttonVariants()}>Invite someone</Dialog.Trigger>
  <Dialog.Content
    showCloseButton={false}
    onEscapeKeydown={keepOpenWhileSubmitting}
    onInteractOutside={keepOpenWhileSubmitting}
  >
    <Dialog.Header>
      <Dialog.Title>Invite someone to {organizationName}</Dialog.Title>
      <Dialog.Description>
        We'll email them a link to join. The invitation lasts {INVITE_LIFETIME_DAYS} days.
      </Dialog.Description>
    </Dialog.Header>
    <InviteForm {organizationSlug} onInvited={() => (open = false)} bind:submitting>
      {#snippet cancel(
        label,
      )}
        <Dialog.Close class={buttonVariants({ variant: 'outline' })} disabled={submitting}>
          {label}
        </Dialog.Close>
      {/snippet}
    </InviteForm>
  </Dialog.Content>
</Dialog.Root>
