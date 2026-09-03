<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import StubNotice from '$lib/components/stub-notice.svelte';
</script>

<!-- **Stub:** renders a placeholder. It will offer accept or decline per invite, plus the one-time
     notice for any that had already run out.
     Only the person who controls the address can accept, which is why the endpoints match on the
     verified email and not on a token in a link — forwarding the email grants nothing. -->

<PageHeading>Invitations</PageHeading>

<StubNotice />
