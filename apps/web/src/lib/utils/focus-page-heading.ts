import { tick } from 'svelte';

/** Where focus goes when the row it was on disappears (revoked, removed, declined). Without this
 * the browser drops it to `<body>` and a keyboard or screen reader user loses their place; the
 * page's `<h1>` (see `PageHeading`) is a stable landmark every such list sits under. Awaits a tick
 * so a dialog that unmounts along with the row has released its focus trap first. */
export async function focusPageHeading() {
  await tick();
  document.querySelector('h1')?.focus();
}
