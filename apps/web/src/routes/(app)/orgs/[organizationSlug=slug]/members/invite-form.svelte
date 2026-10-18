<script lang="ts">
import type { OrganizationRole } from '@gbd/db';
import type { Snippet } from 'svelte';
import { toast } from 'svelte-sonner';
import { invalidate } from '$app/navigation';
import { Button } from '#lib/components/ui/button/index.js';
import * as Field from '#lib/components/ui/field/index.js';
import { Input } from '#lib/components/ui/input/index.js';
import { RadioGroup, RadioGroupItem } from '#lib/components/ui/radio-group/index.js';
import { MAX_EMAIL_LENGTH } from '#lib/forms/validation.js';
import { createInvite } from '#lib/invites/api/create-invite.js';
import { FIELD } from '#lib/invites/invite.js';
import { MEMBERS_DEPENDENCY } from './dependencies.ts';

interface Props {
  organizationSlug: string;
  /** Called once an invite is created and emailed. Every other outcome stays inline. */
  onInvited: () => void;
  /** True while a request is in flight, for a container that must not close mid-request. */
  submitting?: boolean;
  /** Rendered before "Send invitation", e.g. a dialog's Cancel. */
  cancel?: Snippet;
}

let { organizationSlug, onInvited, submitting = $bindable(false), cancel }: Props = $props();

let email = $state('');
let role: OrganizationRole = $state('member');

type FormState =
  | { status: 'idle' }
  | { status: 'already-member' }
  | { status: 'rate-limited' }
  | { status: 'email-failed' }
  | { status: 'outcome-unknown' };

let formState: FormState = $state({ status: 'idle' });
let emailInputElement: HTMLInputElement | null = $state(null);
const id = $props.id();
const emailErrorId = `${id}-email-error`;
const roleTitleId = `${id}-role-title`;

const ROLES = [
  { value: 'member', label: 'Member', description: 'Can see and upload reports.' },
  {
    value: 'admin',
    label: 'Admin',
    description: 'Can also invite and remove people, and manage the organization.',
  },
] as const satisfies readonly { value: OrganizationRole; label: string; description: string }[];

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (submitting) return;

  submitting = true;
  formState = { status: 'idle' };
  const outcome = await createInvite(organizationSlug, email, role);
  submitting = false;

  if (outcome.kind === 'already-member') {
    formState = { status: 'already-member' };
    emailInputElement?.focus();
    return;
  }
  if (outcome.kind === 'rate-limited') {
    formState = { status: 'rate-limited' };
    return;
  }
  if (outcome.kind === 'unknown') {
    formState = { status: 'outcome-unknown' };
    await invalidate(MEMBERS_DEPENDENCY);
    return;
  }
  // The address stays in the field, so pressing "Send invitation" again resends.
  if (!outcome.emailSent) {
    formState = { status: 'email-failed' };
    await invalidate(MEMBERS_DEPENDENCY);
    return;
  }

  const invitedEmail = email;
  onInvited();
  await invalidate(MEMBERS_DEPENDENCY);
  toast.success(`Invited ${invitedEmail}`);
}
</script>

<form onsubmit={handleSubmit} class="flex flex-col gap-6">
  <Field.Set>
    <Field.Field>
      <Field.Label for={FIELD.email}>Email address</Field.Label>
      <Input
        bind:ref={emailInputElement}
        id={FIELD.email}
        name={FIELD.email}
        type="email"
        maxlength={MAX_EMAIL_LENGTH}
        required
        autocomplete="off"
        aria-invalid={formState.status === 'already-member' || undefined}
        aria-describedby={formState.status === 'already-member' ? emailErrorId : undefined}
        bind:value={email}
      />
      {#if formState.status === 'already-member'}
        <Field.Error id={emailErrorId}>That person is already a member.</Field.Error>
      {/if}
    </Field.Field>

    <Field.Field>
      <Field.Title id={roleTitleId}>Role</Field.Title>
      <RadioGroup
        aria-labelledby={roleTitleId}
        name={FIELD.role}
        value={role}
        onValueChange={(value) => (role = value as OrganizationRole)}
      >
        {#each ROLES as option (option.value)}
          <Field.Field orientation="horizontal">
            <RadioGroupItem
              value={option.value}
              id="{id}-role-{option.value}"
              aria-describedby="{id}-role-{option.value}-description"
            />
            <Field.Content>
              <Field.Label for="{id}-role-{option.value}">{option.label}</Field.Label>
              <Field.Description id="{id}-role-{option.value}-description">
                {option.description}
              </Field.Description>
            </Field.Content>
          </Field.Field>
        {/each}
      </RadioGroup>
    </Field.Field>
  </Field.Set>

  {#if formState.status === 'rate-limited'}
    <p role="alert" class="text-sm text-destructive">
      You've sent too many invites. Try again in an hour.
    </p>
  {:else if formState.status === 'email-failed'}
    <p role="status" class="text-sm text-muted-foreground">
      They're invited, but we couldn't email them. Send the invite again to retry.
    </p>
  {:else if formState.status === 'outcome-unknown'}
    <p role="alert" class="text-sm text-destructive">
      We couldn't tell whether that invite was sent. Close this and check Pending invitations. If
      it's not there, try again.
    </p>
  {/if}

  <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    {@render cancel?.()}
    <Button type="submit" disabled={submitting} aria-busy={submitting}>
      {submitting ? 'Sending…' : 'Send invitation'}
    </Button>
  </div>
</form>
