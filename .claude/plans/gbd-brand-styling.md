# Style the web app after Greener by Default's site

## Context

The web app still wears shadcn's stock neutral theme: near-black buttons, gray text, Inter
everywhere, and nothing that says Greener by Default (see `apps/web/e2e/__screenshots__/`). GBD's
own site (greenerbydefault.com) has a clear identity:

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

## Constraint that shaped the palette

`expectScreenshots` runs axe (`apps/web/e2e/lib/a11y.ts`) on every screen at every width, so
color contrast is enforced. GBD's own teal fails that check, because it is too light to carry
white text (3.3:1 against white). The teal also has to work as *text* on the gray hover
background: `reports-list/list.png` captures a hovered row. Those two needs set the primary
color at OKLCH lightness 0.51.

## Palette (`:root` in `apps/web/src/routes/layout.css`)

| Token | Value | ≈ Hex | Why |
| --- | --- | --- | --- |
| `--primary`, `--ring` | `oklch(0.51 0.105 181)` | `#007969` | GBD teal darkened: 5.3:1 with white text, 4.8:1 as text on `--accent` |
| `--primary-hover` (new) | `oklch(0.44 0.105 181)` | `#006456` | Hover darkens; today's `bg-primary/80` fades, which would drop white text below AA |
| `--primary-foreground` | `oklch(1 0 0)` | white | |
| `--heading` (new) | `oklch(0.369 0.068 252)` | `#234162` | GBD heading navy, 9.5:1 even on `--accent` |
| `--foreground` (and card/popover/accent/secondary foregrounds) | `oklch(0.21 0.02 255)` | `#121921` | Near-black with a navy cast |
| `--muted-foreground` | `oklch(0.52 0.025 258)` | `#606A78` | Cool slate near GBD's `#4A5464`, kept lighter to preserve hierarchy: 5.5:1 on white, 5.0:1 on `--accent` |
| `--muted`, `--accent`, `--secondary` | `oklch(0.965 0.006 250)` | `#F0F4F7` | GBD's card gray |
| `--border`, `--input` | `oklch(0.915 0.008 250)` | `#DFE3E8` | Cool gray to match |
| `--radius` | `0.375rem` (was `0.625rem`) | | Points toward GBD's square buttons without going fully square |
| `--destructive` | unchanged | | |

Leave the dead `.dark` block, `--chart-*` and `--sidebar-*` alone. They're unused, and dark mode
is out of scope. Open `:root` with a short comment covering three things a reader can't recover
from the values: they come from greenerbydefault.com (captured 2026-10-18), the teal is darker
than GBD's on purpose, and why (the two contrast pairs above).

## PR 1: palette and heading typeface

Every screen changes, so this PR's review is mostly the screenshot diff.

- **Font dependency.** Add `'@fontsource-variable/jost': ^5.3.0` to the styling block of
  `pnpm-workspace.yaml`, and add `"@fontsource-variable/jost": "catalog:"` to the devDependencies
  in `apps/web/package.json`, next to Inter. The license is OFL-1.1. The font is self-hosted
  through Vite, which the CSP's `default-src 'self'` already allows.
- **`layout.css`:**
  - `@import "@fontsource-variable/jost";`
  - The palette above.
  - In `@theme inline`: `--font-heading: "Jost Variable", sans-serif;`,
    `--color-heading: var(--heading);` and `--color-primary-hover: var(--primary-hover);`.
  - In `@layer base`: `h1, h2, h3 { @apply font-heading text-heading; }`. This one rule reaches
    page headings, section headings, the error page and the marketing page. Utilities still win,
    so headings that set `text-muted-foreground` keep it.
- **Dialog titles.** bits-ui renders these as `<div role="heading">`, not `h2`, so the base rule
  misses them. Add `font-heading text-heading` to the class strings in
  `ui/dialog/dialog-title.svelte` and `ui/alert-dialog/alert-dialog-title.svelte`.
- **Heading class lists.** Jost's x-height is smaller than Inter's, and GBD sets headings at 500
  without tracking. So:
  - Change `font-semibold` to `font-medium` and drop `tracking-tight`.
  - Raise section `h2`s one size, from the base size to `text-lg`.
  - Files: `lib/components/page-heading.svelte` (h1 → `text-3xl`), `lib/components/error-page.svelte`,
    `routes/+page.svelte`, `members/+page.svelte`, `reports/[reportId=uuid]/upload-details.svelte`,
    `reports/new/rejection-view.svelte` and `invites/invite-offer.svelte`.
  - `reports/new/monthly-counts.svelte`'s year `h2` is styled as a small muted label. Give it
    `font-sans` so it stays one.
- **`ui/field/field-legend.svelte`.** Change `data-[variant=legend]:text-base` to
  `font-heading text-heading text-lg` under the same variant. Form section titles ("Purchasing
  data", "Report details", "Delete account") then match the other headings. The `label` variant
  stays Inter.
- **`ui/button/button.svelte`.** In the default variant, change `hover:bg-primary/80` to
  `hover:bg-primary-hover`.

## PR 2: brand touches in the chrome, links, statuses and marketing page

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

Branch from `main` once the `improve-upload-form-ui` PR has merged. Both PRs regenerate the
`new-report` screenshots, and PR 2 edits `upload-form.svelte`. PR 2 then stacks on PR 1.

## Out of scope

- Dark mode.
- The GBD logo.
- Page layout or structure changes.
- A marketing page redesign.
- Raising button heights to 44px. `button.svelte`'s comment already leaves that for a redesign.

## Verification (each PR)

1. Install and regenerate:
   - PR 1 only: run `pnpm install` after the catalog edit.
   - Then `pnpm turbo run screenshots:update --filter=@gbd/web`. It must go through Turbo so the
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
3. PR 2: `pnpm --filter @gbd/web test:unit
   'src/routes/(app)/orgs/[organizationSlug=slug]/reports-list/report-status.svelte.test.ts'`.
4. Gate, run in the background: `pnpm lint && pnpm check && pnpm test`.
