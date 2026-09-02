/** displayName is null when the user is deleted. */
export type Creator = { displayName: string | null; email: string } | null;

// Lowercase, so it reads naturally after "Created by".
function creatorName(creator: Creator): string {
  if (creator === null) return 'a deleted user';
  return creator.displayName ?? creator.email;
}

/** The "site · Created by name" (or just "Created by name") line shown under a report's name,
 * on both the report list row and the report page heading. */
export function subheading(siteName: string | null, creator: Creator): string {
  const parts = [...(siteName ? [siteName] : []), `Created by ${creatorName(creator)}`];
  return parts.join(' · ');
}
