<script lang="ts">
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import { goto } from '$app/navigation';
import { deleteAccount } from '$lib/account/api/delete-account';
import type { BrowserAuth } from '$lib/auth/browser';
import ConfirmAction, { ConfirmActionError } from '$lib/components/confirm-action.svelte';
import { Button } from '$lib/components/ui/button';
import * as Field from '$lib/components/ui/field';
import { organizationMembersHref } from '$lib/hrefs';
import type { SoleAdminOrganization } from './+page.server.ts';

interface Props {
  // A prop, rather than a call to `browserAuth()`, so tests can fake it.
  auth: BrowserAuth;
  email: string;
  soleAdminOrganizations: readonly SoleAdminOrganization[];
}

let { auth, email, soleAdminOrganizations }: Props = $props();

const blockingOrganizations = $derived(
  soleAdminOrganizations.length === 1 ? 'this organization' : 'these organizations',
);

async function confirm() {
  const outcome = await deleteAccount();
  if (outcome.kind === 'last-admin') {
    // Promoted to sole admin since the page loaded — the list above is stale.
    throw new ConfirmActionError(
      "You're now the only admin of an organization. Reload the page to see which.",
    );
  }
  if (outcome.kind === 'unknown') throw new Error('delete failed; falls back to errorMessage');

  // The account is gone either way, and the server hook clears the cookie of a deleted user's
  // session, so a sign-out that fails — even one whose client never loaded — still lands on a
  // signed-out `/`.
  try {
    await auth.signOut({ scope: 'local' });
  } catch (cause) {
    console.error('Could not sign out of a deleted account', cause);
  }
  await goto('/', { invalidateAll: true });
}
</script>

{#snippet trigger()}
  <Trash2Icon aria-hidden="true" />
  Delete account
{/snippet}

<Field.Set>
  <Field.Legend>Delete account</Field.Legend>
  {#if soleAdminOrganizations.length > 0}
    <Field.Description>
      You're the only admin of {blockingOrganizations}. Before you can delete your account, make
      someone else an admin or delete the organization.
    </Field.Description>
    <ul class="flex flex-col gap-1 text-sm">
      {#each soleAdminOrganizations as organization (organization.slug)}
        <li>
          <a class="underline" href={organizationMembersHref(organization.slug)}>
            {organization.name}
          </a>
        </li>
      {/each}
    </ul>
    <Button variant="outline" disabled>{@render trigger()}</Button>
  {:else}
    <Field.Description>
      This permanently deletes your account and removes you from every organization. Reports you
      submitted stay with their organizations.
    </Field.Description>
    <ConfirmAction
      {trigger}
      title="Delete your account?"
      description="You'll be signed out, and your name and organization memberships go with the account. This can't be undone."
      confirmLabel="Yes, delete my account"
      cancelLabel="Keep it"
      errorMessage="Could not delete your account. Please try again."
      confirmPhrase={email}
      onConfirm={confirm}
    />
  {/if}
</Field.Set>
