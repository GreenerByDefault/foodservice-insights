<script lang="ts">
import { invalidateAll } from '$app/navigation';
import DisplayNameForm from '$lib/components/account/display-name-form.svelte';
import PageHeading from '$lib/components/page-heading.svelte';
import * as Field from '$lib/components/ui/field';
import type { PageProps } from './$types';

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
</div>

<!-- **Stub:** changing the email and deleting the account are still to come.
     Changing an email is a browser-side `updateUser` followed by `verifyOtp` with type
     `email_change`, like the rest of auth — no route of ours is involved. That holds only while
     Supabase's email-change template is set to send `{{ .Token }}`; left as the default link, the
     flow needs a server route to receive the click, which is exactly what email OTP was chosen to
     avoid.
     Deleting is `DELETE /api/account`, which needs the service-role key, so it cannot be done from
     the browser. -->
