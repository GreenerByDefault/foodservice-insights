# Style the web app after Greener by Default's site

## Context

The web app started from shadcn's stock neutral theme, with nothing that said Greener by
Default. GBD's own site (greenerbydefault.com) has a clear identity:

- **Navy** headings (`#234162`, with `#082A59` for the largest).
- **Teal** call-to-action buttons and section bands (`#1B9F8D`).
- **Futura PT** headings at weight 500, with Poppins body text.
- Square-cornered buttons, and cool light gray for card backgrounds (`#EEF0F2`).

The goal is to look better and recognizably GBD without getting noisy. No layout restructuring,
no dark mode, and no logo: REQUIREMENTS.md § Landing page says GBD comms will supply the mark and
the marketing design.

These were decided with Eric:
- **Typefaces:** Jost for headings, a free OFL Futura look-alike. Inter stays for body text,
  forms and lists.
- **Primary buttons:** teal.
- **Logo:** none yet. The app name becomes a styled text wordmark.

## What is already in place

The palette and heading typeface have landed. `apps/web/src/routes/layout.css` holds the GBD
colors as tokens, and its `:root` comment explains them. The work below builds on these:

- **`text-primary` / `bg-primary`** is GBD's teal darkened to OKLCH lightness 0.51 (≈ `#007969`).
  `expectScreenshots` runs axe (`apps/web/e2e/lib/a11y.ts`) on every screen at every width, and
  GBD's own `#1B9F8D` fails it with white text. The darker teal clears 4.5:1 both under white text
  and as text on `--accent`. That second pair is what lets "Ready" turn teal: `reports-list/list.png`
  captures that row hovered.
- **`font-heading text-heading`** is Jost in GBD navy (`#234162`). A base rule applies it to `h1`–`h3`,
  so a non-heading element like the wordmark has to ask for it.
- **`hover:bg-primary-hover`** darkens the teal on hover. Opacity modifiers on `bg-primary` fade
  it instead, and white text on a faded teal drops below AA.

## PR 1: brand touches in the chrome, links, statuses and marketing page

- **Favicon** (`lib/assets/favicon.svg`):
  - Recolor it: rect `#171717` → navy `#234162`, leaf `#fff` → GBD teal `#1B9F8D` (3.2:1 on navy,
    which passes the 3:1 bar for graphics), and the vein stroke → navy.
  - Regenerate `static/favicon.ico` and `static/apple-touch-icon.png` with the commands in the
    file's own comment. Change the touch icon's `-b` to `'#234162'`. `rsvg-convert` and `magick`
    are already installed at `/opt/homebrew/bin`.
- **Wordmark** (new `lib/components/wordmark.svelte`):
  - It's a link to `/`: the favicon as `<img alt="">`, since the name follows it, then `APP_NAME`
    in `font-heading text-lg font-medium text-heading`.
  - It takes a `class` prop, so the app header can keep its `hidden sm:flex`.
  - It replaces the two differently styled `APP_NAME` links in `lib/components/public-header.svelte`
    and `routes/(app)/+layout.svelte`. Carry over the comment explaining why `/` is right when
    signed in.
- **Organization tabs** (`orgs/[organizationSlug=slug]/+layout.svelte`): change the active tab's
  `aria-[current=page]:border-foreground` to `border-primary`, giving it a teal underline.
- **Inline links:**
  - Add `@utility link { @apply text-primary underline underline-offset-2 hover:no-underline; }`
    beside `page-width` in `layout.css`.
  - Apply it to the six hand-styled anchors in `create-organization-form.svelte`,
    `canceled-view.svelte`, `upload-details.svelte` (×2), `upload-form.svelte` and
    `delete-account.svelte`. Today some use `underline` and some use `underline hover:no-underline`;
    this unifies them.
- **Report status** (`reports-list/report-status.svelte`): show "Ready" (`succeeded`) in
  `text-primary`, so finished reports stand out in the list.
  - Extend the matching test in `report-status.svelte.test.ts` to
    `toHaveClass('text-primary')`, renamed to match its siblings: "succeeded reads as Ready, in the
    primary colour".
- **Marketing page** (`routes/+page.svelte`). Keep the copy and structure, since comms owns the
  redesign.
  - "From Greener by Default" in `text-primary`.
  - The "How it works" band changes from `border-t bg-muted/40` to `bg-primary/5`, a pale echo of
    GBD's teal bands.
  - Step numbers become filled teal circles (`bg-primary text-primary-foreground`, no border).
  - In the footer, link "Greener by Default" to `https://www.greenerbydefault.com` with the `link`
    utility.

Use the `svelte-file-editor` subagent for `wordmark.svelte`, or run `svelte-autofixer` on each
Svelte file changed.

## Sequencing

Stack on the palette PR (branch `gbd-style-pr1`), which itself stacks on `improve-upload-form-ui`.
This PR edits `upload-form.svelte` and regenerates the same screenshots, so wait for both rather
than branching from `main`.

## Out of scope

- Dark mode.
- The GBD logo.
- Page layout or structure changes.
- A marketing page redesign.
- Raising button heights to 44px. `button.svelte`'s comment already leaves that for a redesign.

## Verification

1. Regenerate:
   - `pnpm turbo run screenshots:update --filter=@gbd/web`. It must go through Turbo so the
     build is fresh. It rewrites about 165 PNGs.
   - Every capture also runs axe, including its color-contrast check, at all three widths. A palette
     value that fails AA fails the run. Fix the token; don't exempt it.
2. Compare old and new images:
   - Screens: `marketing`, `auth/sign-in-email`, `reports-list/list` (the hovered "Ready" row),
     `new-report/filled`, `reports/succeeded`, `reports/processing`, `members/as-admin`,
     `account/account-delete-dialog`, `organizations/organization-switcher` and
     `errors/not-found`.
   - Check desktop and `mobile/` for each.
   - Look for heading sizes that wrap badly on mobile, and for anything that reads as noisy.
3. `pnpm --filter @gbd/web test:unit
   'src/routes/(app)/orgs/[organizationSlug=slug]/reports-list/report-status.svelte.test.ts'`.
4. Gate, run in the background: `pnpm lint && pnpm check && pnpm test`.
