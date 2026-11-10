/** Is this request a chat app fetching a link preview, rather than a person?
 *
 * Some apps build the preview on the sender's own device — iMessage among them, under a
 * `facebookexternalhit … Twitterbot` user agent — and that fetch can carry the sender's session
 * cookie. Served as the sender, the preview shows whatever the page's `<title>` names: an
 * organization, a report's file name. So a preview is always served signed out, whatever cookie it
 * holds, and gets the same sign-in page as anyone else holding the link.
 *
 * Matching only ever drops a session, so a false positive costs a sign-in form, never access. Each
 * pattern is a fetcher's token, not the in-app browser the same company ships (`FBAN`,
 * `LinkedInApp`, `Slack_SSB`), which a person really does browse with.
 */
const LINK_PREVIEW_USER_AGENT =
  /facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|TelegramBot|LinkedInBot|SkypeUriPreview|^WhatsApp\//i;

export function isLinkPreview(userAgent: string | null): boolean {
  return userAgent !== null && LINK_PREVIEW_USER_AGENT.test(userAgent);
}
