<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import type { PageProps } from './$types';
import InviteOffers from './invite-offers.svelte';

let { data }: PageProps = $props();
</script>

<PageHeading>Invitations</PageHeading>

<InviteOffers invites={data.invites} />
