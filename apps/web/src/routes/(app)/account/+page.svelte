<script lang="ts">
import { invalidateAll } from '$app/navigation';
import { browserAuth } from '$lib/auth/browser';
import { authMode } from '$lib/auth/mode';
import DisplayNameForm from '$lib/components/account/display-name-form.svelte';
import PageHeading from '$lib/components/page-heading.svelte';
import * as Field from '$lib/components/ui/field';
import type { PageProps } from './$types';
import DeleteAccount from './delete-account.svelte';

let { data }: PageProps = $props();
</script>

<PageHeading>Account</PageHeading>

<div class="flex w-full max-w-md flex-col gap-8">
  <Field.Field>
    <Field.Title>Email</Field.Title>
    <p class="text-sm text-muted-foreground">{data.user.email}</p>
  </Field.Field>

  <DisplayNameForm
    initialName={data.user.displayName ?? ''}
    submitLabel="Save"
    onSaved={invalidateAll}
  />

  <!-- `placeholder` mode has no session to end, and deleting its one user breaks every request. -->
  {#if authMode() === 'supabase'}
    <Field.Separator />

    <DeleteAccount
      auth={browserAuth()}
      email={data.user.email}
      soleAdminOrganizations={data.soleAdminOrganizations}
    />
  {/if}
</div>

<!-- **Stub:** changing the email is still to come. It is a browser-side `updateUser` followed by
     `verifyOtp` with type `email_change`, like the rest of auth — no route of ours is involved.
     That holds only while Supabase's email-change template is set to send `{{ .Token }}`; left as
     the default link, the flow needs a server route to receive the click, which is exactly what
     email OTP was chosen to avoid. -->
