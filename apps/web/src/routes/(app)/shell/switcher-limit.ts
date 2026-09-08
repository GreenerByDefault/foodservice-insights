// Its own file because `organization-switcher.svelte` is a plain component, and a `.svelte` file
// can't import from a `+layout.server.ts`.

/** How many organizations the switcher lists before handing off to `/orgs`.*/
export const SWITCHER_LIMIT = 8;
