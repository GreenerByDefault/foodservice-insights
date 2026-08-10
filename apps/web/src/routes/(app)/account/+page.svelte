<!-- **Stub:** renders a placeholder. It will offer rename, change email, and delete the account.
     Changing an email is a browser-side `updateUser` followed by `verifyOtp` with type
     `email_change`, like the rest of auth — no route of ours is involved. That holds only while
     Supabase's email-change template is set to send `{{ .Token }}`; left as the default link, the
     flow needs a server route to receive the click, which is exactly what email OTP was chosen to
     avoid.
     Deleting is `DELETE /api/account`, which needs the service-role key, so it cannot be done from
     the browser. -->
<h1 class="text-2xl font-semibold tracking-tight">Account</h1>

<p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>
