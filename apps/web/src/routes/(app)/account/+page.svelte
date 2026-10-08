<script lang="ts">
import { refreshAll } from '$app/navigation';
import { browserAuth } from '#lib/auth/browser.js';
import { authMode } from '#lib/auth/mode.js';
import DisplayNameForm from '#lib/components/account/display-name-form.svelte';
import PageHeading from '#lib/components/page-heading.svelte';
import * as Field from '#lib/components/ui/field/index.js';
import type { PageProps } from './$types';
import { pageTitle } from '#lib/page-title.js';
import ChangeEmailForm from './change-email-form.svelte';
import DeleteAccount from './delete-account.svelte';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Account')}</title>
</svelte:head>

<PageHeading>Account</PageHeading>

<!-- `placeholder` mode has no session to change or end, and deleting its one user breaks every
     request. -->
<div class="flex w-full max-w-md flex-col gap-8">
  {#if authMode() === 'supabase'}
    <ChangeEmailForm auth={browserAuth()} currentEmail={data.user.email} />
  {:else}
    <Field.Field>
      <Field.Title>Email</Field.Title>
      <p class="text-sm text-muted-foreground">{data.user.email}</p>
    </Field.Field>
  {/if}

  <DisplayNameForm
    initialName={data.user.displayName ?? ''}
    submitLabel="Save"
    onSaved={refreshAll}
  />

  {#if authMode() === 'supabase'}
    <Field.Separator />

    <DeleteAccount
      auth={browserAuth()}
      email={data.user.email}
      soleAdminOrganizations={data.soleAdminOrganizations}
    />
  {/if}
</div>
