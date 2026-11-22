# Restyle PLATE after GBD's 2026 rebrand

## Context

greenerbydefault.com relaunched with a new logo and visual identity. Our styling (#640, #642,
October 2026) copied their *old* site: navy, teal `#1B9F8D`, Jost headings and Inter body text.
GBD will send visual edits later. This plan matches their new look now, so those edits only
need to change tokens. The scope is UI and styling, not UX: layouts and copy stay as they are.

**What their site uses (from the live site, 2026-11-22):**

| Element | Value |
| --- | --- |
| Font | Poppins 400/500/600/700 for everything, body text included |
| Headings | Bold 700, UPPERCASE, tracking -0.05em, deep green |
| Brand green | `#016939`: headings, buttons, full-bleed bands |
| Page background | Cream `#FDF9F1`, on every page |
| Body text | Warm brown `#403428` |
| Accent | Chartreuse `#D9E027`: announcement bar, underline under a key headline word, button text on green |
| Buttons | Pill shape (`border-radius: 300px`), bold, uppercase. Cream or chartreuse text on green |
| Logo | Green pill holding a cream circle with a leaf, beside "GREENER BY DEFAULT" |

**Contrast, which the token comment in `layout.css` should record:**

| Pair | Ratio | Rule |
| --- | --- | --- |
| Green on cream | 6.5:1 | AA |
| Cream on green | 6.5:1 | AA |
| Chartreuse on green | 4.7:1 | AA |
| Brown on cream | 11.5:1 | AA |
| Chartreuse on cream | 1.4:1 | Decoration only. Never text, a focus ring or a link underline |
| GBD's link green `#049250` on cream | 3.8:1 | Fails AA, so links use `#016939` |

**Decisions made with the user:**
- Draw an original PLATE mark in the new style. Swap it for official art when GBD sends some.
- Use Poppins everywhere, matching their site.
- UPPERCASE only for marketing-page headings, eyebrow labels and buttons. In-app headings stay sentence case, because they show user content such as report and org names.
- Restyle the emails and the PDF too.
- Do not prune screenshots first.

Throwaway mockups of the target look are in `.playwright-mcp/` (gitignored):
`mockup-marketing.png` and `mockup-report.png`.

## PR breakdown

| PR | What | Screenshots | Depends on |
| --- | --- | --- | --- |
| 1 | Web: tokens, Poppins, buttons, logo, `error.html` | all 168 | — |
| 2 | Web: marketing page brand treatment | 3 (`marketing`) | 1 |
| 3 | Emails: `packages/email` + Supabase auth templates | none | — (palette from 1) |
| 4 | PDF report (Python) | none | — (palette from 1) |

The logo goes in PR 1 because every screen's header shows it. Putting it in its own PR would
regenerate all 168 images a second time. PRs 3 and 4 are independent, and either can land in
parallel once PR 1 has settled the palette.

On approval, run `/plan-adopt` to bring this plan into `.claude/plans/` as
`gbd-2026-rebrand.md`, following the repo convention for features that span several PRs. Then
fold each PR back in with `/plan-advance`.

## PR 1: web app restyle

**Tokens** in `apps/web/src/routes/layout.css`, the only file that defines them. Write the
values in oklch to match the file. Replace the header comment with the new capture date and
the contrast rules above.

| Token | Value |
| --- | --- |
| `--background` | cream `#FDF9F1` |
| `--foreground`, and every `*-foreground` that currently holds the navy-ish `0.21 0.02 255` | brown `#403428` |
| `--card`, `--popover` | white, so they stand off the cream page |
| `--primary`, `--ring`, `--heading` | green `#016939` |
| `--primary-hover` | about `#01532D` |
| `--primary-foreground` | cream `#FDF9F1` |
| `--secondary`, `--muted`, `--accent` | sand `#F4EEE2` (green on sand is 5.5:1) |
| `--muted-foreground` | `#6E6052` (5.8:1 on cream, 5.2:1 on sand) |
| `--border`, `--input` | `#E6DDCC` |
| `--highlight` (new) | chartreuse `#D9E027`, mapped as `--color-highlight` in `@theme inline` |
| `--radius` | `0.5rem` |
| `--destructive` | unchanged |

**Fonts**
- In the `pnpm-workspace.yaml` catalog and `apps/web/package.json`, replace
  `@fontsource-variable/inter` and `@fontsource-variable/jost` with `@fontsource/poppins`.
  Poppins has no variable cut.
- Import only `400.css`, `500.css`, `600.css` and `700.css`.
- Set both `--font-sans` and `--font-heading` to `"Poppins", sans-serif`. Keep `font-heading` as
  its own token so GBD can split the two fonts later with a one-line change.

**Headings**
- In the `@layer base` rule for `h1, h2, h3`, add `font-bold tracking-tight`.
- Remove the `font-medium` that #640 put on headings: `page-heading.svelte:16`,
  `error-page.svelte:54`, `wordmark.svelte`, `ui/dialog/dialog-title.svelte`,
  `ui/alert-dialog/alert-dialog-title.svelte` and `ui/field/field-legend.svelte`. Grep
  `font-medium` next to `font-heading` and `text-heading` to find any others.

**Buttons** (`apps/web/src/lib/components/ui/button/button.svelte`)
- In the base classes, change `rounded-md` to `rounded-full` and `font-medium` to
  `font-semibold uppercase tracking-wide`.
- Drop the `rounded-[min(var(--radius-md),Npx)]` caps on the `xs`, `sm`, `icon-xs` and `icon-sm`
  sizes. Keep `in-data-[slot=button-group]:rounded-md`.
- Give the `link` variant `normal-case tracking-normal font-medium`, since it sits inside
  running text.
- Raise `default` to `h-10 px-4` and `lg` to `h-11 px-5`, so pill buttons have room. Update the
  WCAG 2.5.5 comment to match: `lg` now reaches 44px.
- Change `outline` to a green border with green text (`border-primary text-primary`), as in the
  mockup.
- Buttons that display user content opt out with `normal-case`:
  `routes/(app)/shell/organization-switcher.svelte` (org name) and
  `routes/(app)/shell/user-menu.svelte` (initials). Audit every file that uses `buttonVariants`
  or `<Button` for others.

**Form controls**
- `ui/input`, the OTP slots and any select trigger get a white fill (`bg-card`), so they stand
  off the cream page, as GBD's forms do. Check `ui/input/input.svelte` for its current
  `bg-transparent`.

**Logo**
- Redraw `apps/web/src/lib/assets/favicon.svg` as a green disc with a cream leaf. That reads at
  16px.
- Add `lib/assets/mark.svg`: a green pill holding a cream disc with a green leaf (the mockup's
  header mark). This is our own drawing in GBD's idiom, not a copy of their logo.
- `wordmark.svelte` shows `mark.svg` beside `APP_NAME` in Poppins bold green with tight tracking.
  Update its doc comment, which currently says the mark is a stand-in until GBD supplies a logo.
- Regenerate `static/favicon.ico` and `static/apple-touch-icon.png` with the commands in the
  SVG's header comment, with the `-b` color changed to `#016939`.

**`apps/web/src/error.html`**
- Re-copy the values by hand: cream background, brown text, muted `#6E6052`, green h1 at weight
  700, and `font-family: "Poppins", system-ui, sans-serif`. The page cannot load the font, so
  the fallback is expected.
- This also fixes the drift it already has, where it still uses the old neutral grays.

**Leave alone:**
- The amber `data-quality-notice.svelte` and `timeline.svelte`. Warning semantics stay amber,
  and the mockup shows amber sitting fine on cream. Revisit only if a regenerated screenshot
  clashes.
- The dialog overlays' `bg-black/10`.
- The dead `.dark` block.

**Risk:** CSS `uppercase` changes `innerText` but not `textContent` or accessible names.
Playwright and vitest tests that read `innerText`, or use `useInnerText`, will see capitals.
Fix the assertion, not the style.

Hand the `.svelte` edits to the `svelte-file-editor` subagent, or run `svelte-autofixer` on
each changed file (`.claude/rules/web.md`).

## PR 2: marketing page (`apps/web/src/routes/+page.svelte`)

Follow `mockup-marketing.png`:
- **Eyebrow:** "From Greener by Default" in `text-xs font-bold uppercase tracking-widest
  text-primary`.
- **Hero h1:** `uppercase tracking-tighter leading-none`, at `text-4xl sm:text-6xl`. The words
  "climate impact" sit in a `<span>` with a chartreuse underline bar: a `bg-highlight` gradient
  sized to about 8px at the baseline. That keeps the bar decorative, with no text on
  chartreuse.
- **Lead paragraph:** `text-lg font-medium text-foreground`.
- **CTA:** a green pill with chartreuse text (`text-highlight`, 4.7:1 on green), like GBD's
  "Donate" button. Add a `brand` variant to `button.svelte` only if a second use appears;
  otherwise use a class on this one button.
- **"How it works" band:**
  - Use a full-bleed `bg-primary text-primary-foreground` band in place of `bg-primary/5`.
  - The h2 is uppercase and cream (override `text-heading`).
  - Step numbers are chartreuse discs with green numerals.
  - Step bodies use `text-primary-foreground/90`. Check axe contrast.
- **Footer:** keep the "a tool from Greener by Default" link. It inherits the new tokens.

## PR 3: emails

- In `packages/email/src/messages/layout.ts`, update the styles:

  | Style | New values |
  | --- | --- |
  | `BODY_STYLE` | background `#FDF9F1`, color `#403428`; font stack `Poppins,-apple-system,…` (clients can't load webfonts reliably, so the stack falls back) |
  | `CARD_STYLE` | stays white, `border-radius:12px` |
  | `ACTION_STYLE` | `#016939` background, `#FDF9F1` text, `border-radius:999px`, uppercase, `letter-spacing:.04em`, weight 700. Replaces `#166534` |
  | h1 | green, weight 700 |
  | Footer | `#6E6052` |
  | Links | `#016939` |

- Update the footer color string asserted at `layout.test.ts:32`.
- Copy the same inline values into the three templates in `supabase-dev/supabase/templates/`
  (`sign-in-code`, `email-change`, `email-changed`). `supabase-test` reuses those files.
- **Human step, called out in the PR description:** paste the three templates into the hosted
  Supabase dashboard for production. Restart Kong locally to preview them.
- No logo image. An image would need an absolute app-origin URL from `static/` (see the comment
  in `layout.ts`), and that is not worth it now.

## PR 4: PDF report (`python/insights/gbd_foodservice_insights/`)

**Palette** (`plotting_utils.py`)
- Add named constants: `GBD_GREEN` `#016939`, `GBD_CHARTREUSE` `#D9E027`, `GBD_BROWN`
  `#403428`, `GBD_SAND` `#F4EEE2`, `GBD_BORDER` `#E6DDCC`.
- Rebuild `GBD_COLORS` from them as a 7-color categorical palette that leads with green and
  chartreuse. Validate it with the `dataviz` skill's palette check for adjacent-hue separation
  and color-vision deficiency.
- Keep the length at 7. The lab and notebooks cycle through it.

**Semantic colors** (`report/plots/panels.py:268-269`)
- Replace the index-based `_PLANT_COLOR = GBD_COLORS[2]` and `_NON_PLANT_COLOR = GBD_COLORS[0]`
  with named colors: plant is `GBD_GREEN`, non-plant a warm brown or gray.
- Single-series bars (`panels.py:101`, `figures.py:164`) use `GBD_GREEN`.

**`report/pdf.py`**

| Line(s) | Element | Change |
| --- | --- | --- |
| 137 | Title-page footer | `#234162` → green |
| 239 | Headline CO₂e | `#006a62` → green |
| 255 | Subtitle | `#444444` → brown |
| 572–574 | Table header | `#234162` → green fill with cream bold text |
| 556 | Table borders | `#D9E1EA` → `GBD_BORDER` |
| 581 | Banded rows | `#F5F8FB` → `GBD_SAND` |

Page backgrounds stay white, for printing.

**Fonts**
- Commit `Poppins-Regular.ttf`, `Poppins-SemiBold.ttf`, `Poppins-Bold.ttf` and `Poppins-OFL.txt`
  to `data_files/fonts/`. Delete Lato and Montserrat.
- Update `FONT_FILES`. Set `TITLE_FONT` and `BODY_FONT` to `"Poppins"`, and keep both names as
  the API.
- Replace every literal `fontfamily="Montserrat"` or `"Lato"` in `pdf.py` with the constants.
- In `tests/report/test_pdf.py` (lines 74-93 and 199) and `test_plotting_utils.py`, use the
  constants too.
- Update `data_files/README.md`.

**Lab code**
- These files reference the fonts or `GBD_COLORS`: `data_profile_plots.py`,
  `plotting_extras.py`, `procurement_serving_comparison.py`, `food_report/serving.py`,
  `pilot/plots.py` and `extraction/pdf.py`.
- Switch any literal font names in them to the constants.
- Name the palette change in the PR description, since notebooks in `client_work/` see it too
  (`.claude/rules/python.md`).

**Risk:** Poppins is wider than Lato. `_wrap_to_width` measures text with the real font, so
wrapped text adapts. Fixed layouts may still overflow: the title page and table column widths.
Render the PDF and check it.

## Verification

**PR 1 and PR 2 (web)**
- `pnpm turbo run screenshots:update --filter=@gbd/web`. This needs Docker and `oxipng`, and
  runs axe, including color-contrast, at every viewport.
- Review the diffs, especially:
  - `reports/succeeded`, `new-report/rejection-every-kind`, `auth/sign-in-email-failed` and
    `organizations/organization-switcher`
  - the `mobile/` versions of the header and button wrapping
  - `marketing` at all three viewports
- Run `pnpm lint && pnpm check && pnpm test` in the background, and start no other Turbo task
  until it finishes.
- `pnpm dev` and click through: hover and focus states on buttons, tabs and list rows; dialogs;
  toasts; and the favicon in a browser tab.

**PR 3 (emails)**
- `pnpm --filter @gbd/email preview` to view every app email.
- `pnpm lint && pnpm check && pnpm test`.
- Trigger a sign-in code locally and view it in the local Supabase mail catcher.

**PR 4 (PDF)**
- `just lint && just check && just test`.
- Render a report PDF from the test fixtures that `test_pdf.py` uses, rasterize each page
  (`pdftoppm -png`), and inspect it for overflow, font fallback warnings and chart colors.
