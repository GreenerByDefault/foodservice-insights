<script lang="ts">
import PageHeading from '#lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import InviteOffers from './invite-offers.svelte';
import { pageTitle } from '#lib/page-title.js';

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{pageTitle('Your invitations')}</title>
</svelte:head>

<PageHeading>Your invitations</PageHeading>

<InviteOffers invites={data.invites} />
