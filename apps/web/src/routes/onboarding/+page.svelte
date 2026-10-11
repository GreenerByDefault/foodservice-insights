<script lang="ts">
import { goto } from '$app/navigation';
import DisplayNameForm from '#lib/components/account/display-name-form.svelte';
import PageHeading from '#lib/components/page-heading.svelte';
import PublicShell from '#lib/components/public-shell.svelte';
import { pageTitle } from '#lib/page-title.js';
</script>

<svelte:head>
  <title>{pageTitle('Welcome')}</title>
</svelte:head>

<!-- Reached only through the `(app)` gate's redirect, so there is no page of theirs to return to:
     `/orgs` sends them on to an invite, their organization, or creating one. -->
<PublicShell>
  <div class="flex w-full max-w-sm flex-col gap-4 self-center">
    <PageHeading>Welcome</PageHeading>

    <DisplayNameForm initialName="" submitLabel="Continue" onSaved={() => goto('/orgs')} />
  </div>
</PublicShell>
