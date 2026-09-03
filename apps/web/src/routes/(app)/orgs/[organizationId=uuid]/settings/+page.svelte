<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import StubNotice from '$lib/components/stub-notice.svelte';
</script>

<!-- **Stub:** renders a placeholder. It will offer rename and delete to an admin, and "leave this
     organization" to anyone. Deleting really does destroy the organization's reports and their
     files, unlike deleting a single report, and an admin cannot leave while they are the last
     one. -->

<PageHeading>Settings</PageHeading>

<StubNotice />
