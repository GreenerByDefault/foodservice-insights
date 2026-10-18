<script lang="ts">
import { APP_NAME } from '@gbd/core';
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
    Set up an organization for your school, university, hospital, company or other institution. One
    organization can cover all your sites. Everyone you add will be able to see and upload reports.
  </p>
  <p class="text-sm text-muted-foreground">
    Does your institution already use {APP_NAME}? Ask whoever set it up to invite
    <span class="font-medium wrap-break-word">{data.user.email}</span>
    instead.
  </p>
</div>

<CreateOrganizationForm />
