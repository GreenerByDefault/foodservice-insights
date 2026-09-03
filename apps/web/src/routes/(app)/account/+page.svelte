<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import StubNotice from '$lib/components/stub-notice.svelte';
</script>

<!-- **Stub:** renders a placeholder. It will offer rename, change email, and delete the account.
     Changing an email is a browser-side `updateUser` followed by `verifyOtp` with type
     `email_change`, like the rest of auth — no route of ours is involved. That holds only while
     Supabase's email-change template is set to send `{{ .Token }}`; left as the default link, the
     flow needs a server route to receive the click, which is exactly what email OTP was chosen to
     avoid.
     Deleting is `DELETE /api/account`, which needs the service-role key, so it cannot be done from
     the browser. -->

<PageHeading>Account</PageHeading>

<StubNotice />
