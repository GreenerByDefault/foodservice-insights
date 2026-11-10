<script lang="ts">
import { toast } from 'svelte-sonner';
import { refreshAll } from '$app/navigation';
import { browserAuth } from '#lib/auth/browser.js';
import DisplayNameForm from '#lib/components/account/display-name-form.svelte';
import PageHeading from '#lib/components/page-heading.svelte';
import * as Field from '#lib/components/ui/field/index.js';
import type { PageProps } from './$types';
import { pageTitle } from '#lib/page-title.js';
import ChangeEmailForm from './change-email-form.svelte';
import DeleteAccount from './delete-account.svelte';

let { data }: PageProps = $props();

async function nameSaved(name: string) {
  await refreshAll();
  toast.success(`Name updated to ${name}`);
}
</script>

<svelte:head>
  <title>{pageTitle('Your account')}</title>
</svelte:head>

<PageHeading>Your account</PageHeading>

<div class="flex w-full max-w-md flex-col gap-8">
  <ChangeEmailForm auth={browserAuth()} currentEmail={data.user.email} />

  <DisplayNameForm initialName={data.user.displayName} submitLabel="Save" onSaved={nameSaved} />

  <Field.Separator />

  <DeleteAccount
    auth={browserAuth()}
    email={data.user.email}
    soleAdminOrganizations={data.soleAdminOrganizations}
  />
</div>
