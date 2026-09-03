<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import StubNotice from '$lib/components/stub-notice.svelte';
</script>

<!-- **Stub:** renders a placeholder. It will offer invite, revoke, remove, promote and demote, all
     hidden from a plain member. An organization must keep at least one admin, and the database
     enforces that with a deferred trigger, so the UI's job is to explain the refusal rather than to
     prevent it. -->

<PageHeading>Members</PageHeading>

<StubNotice />
