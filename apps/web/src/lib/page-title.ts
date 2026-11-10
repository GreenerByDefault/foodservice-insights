import { APP_FULL_NAME, APP_NAME } from '@gbd/core';

/** A page's `<title>`: most specific first, so a truncated tab still shows the part that differs.
 * With no segments it is the public page's, where a visitor may not know the name yet. */
export function pageTitle(...segments: string[]): string {
  if (segments.length === 0) return APP_FULL_NAME;
  return [...segments, APP_NAME].join(' · ');
}
