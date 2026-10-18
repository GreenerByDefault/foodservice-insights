<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import CreateOrganizationForm from './create-organization-form.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('New organization')}</title>
</svelte:head>

<PageHeading>New organization</PageHeading>

<!-- The first page a brand-new user sees, so it says what an organization is, and heads off a
     duplicate from someone who is really waiting on a colleague's invite. -->
<div class="flex max-w-prose flex-col gap-2">
  <p>
    An organization is your company or team. Everyone you add to it can see and upload its reports.
  </p>
  <p class="text-sm text-muted-foreground">
    Joining a colleague's organization instead? Ask one of its admins to invite
    <span class="font-medium break-words">{data.user.email}</span>.
  </p>
</div>

<CreateOrganizationForm />
