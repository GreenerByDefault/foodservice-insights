<script lang="ts">
import type { OrganizationRole } from '@gbd/db';
import { invalidateAll } from '$app/navigation';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { Input } from '$lib/components/ui/input';
import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group';
import { MAX_EMAIL_LENGTH } from '$lib/forms/validation';
import { createInvite } from '$lib/invites/api/create-invite';
import { FIELD } from '$lib/invites/invite';

interface Props {
  organizationSlug: string;
}

let { organizationSlug }: Props = $props();

let email = $state('');
let role: OrganizationRole = $state('member');

type FormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'already-member' }
  | { status: 'rate-limited' }
  | { status: 'email-failed' }
  | { status: 'outcome-unknown' };

let formState: FormState = $state({ status: 'idle' });
let emailInputElement: HTMLInputElement | null = $state(null);

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (formState.status === 'submitting') return;

  formState = { status: 'submitting' };
  const outcome = await createInvite(organizationSlug, email, role);

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
    return;
  }

  formState = outcome.emailSent ? { status: 'idle' } : { status: 'email-failed' };
  email = '';
  role = 'member';
  await invalidateAll();
}
</script>

<form onsubmit={handleSubmit} class="space-y-4">
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
        bind:value={email}
      />
      {#if formState.status === 'already-member'}
        <Field.Error>That person is already a member.</Field.Error>
      {/if}
    </Field.Field>

    <Field.Field>
      <Field.Legend variant="label">Role</Field.Legend>
      <RadioGroup
        name={FIELD.role}
        value={role}
        onValueChange={(value) => (role = value as OrganizationRole)}
      >
        <Field.Label>
          <RadioGroupItem value="member" />
          Member
        </Field.Label>
        <Field.Label>
          <RadioGroupItem value="admin" />
          Admin
        </Field.Label>
      </RadioGroup>
    </Field.Field>
  </Field.Set>

  {#if formState.status === 'rate-limited'}
    <p role="alert" class="text-sm text-destructive">
      You've sent too many invites. Try again in an hour.
    </p>
  {:else if formState.status === 'email-failed'}
    <p class="text-sm text-muted-foreground">
      Saved, but the email couldn't be sent — try inviting them again.
    </p>
  {:else if formState.status === 'outcome-unknown'}
    <p role="alert" class="text-sm text-destructive">
      We're not sure whether that invite went through. Check the list above before trying again.
    </p>
  {/if}

  <Button
    type="submit"
    disabled={formState.status === 'submitting'}
    aria-busy={formState.status === 'submitting'}
  >
    {formState.status === 'submitting' ? 'Sending…' : 'Send invitation'}
  </Button>
</form>
