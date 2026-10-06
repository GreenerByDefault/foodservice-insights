import { APP_NAME } from '@gbd/core';

/** A page's `<title>`: most specific first, so a truncated tab still shows the part that differs. */
export function pageTitle(...segments: string[]): string {
  return [...segments, APP_NAME].join(' · ');
}
