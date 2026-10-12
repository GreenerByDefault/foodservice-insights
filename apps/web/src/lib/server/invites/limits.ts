/** How many invites a user may send in a rolling hour — REQUIREMENTS.md § Abuse limits links
 * here. Per inviting user, not per organization: organization creation is uncapped, so a
 * per-organization cap bounds nothing an attacker cares about. */
export const HOURLY_INVITE_LIMIT = 20;
