# Restyle PLATE after GBD's 2026 rebrand

## Context

greenerbydefault.com relaunched with a new logo and visual identity, and GBD will send visual
edits later. The web app already wears the new look: `apps/web/src/routes/layout.css` holds every
color, the font and the radius as tokens, so GBD's edits should only ever change tokens. What is
left is the marketing page's brand treatment, the emails and the PDF, which share no tokens with
the web app and copy the palette by hand. The scope is UI and styling, not UX: layouts and copy
stay as they are.

**The palette**, as the web app ships it. Emails and the PDF copy these hex values:

| Role | Hex | Web token |
| --- | --- | --- |
| Green (buttons, headings, links, focus) | `#016939` | `--primary`, `--heading`, `--ring` |
| Green, hovered | `#01532D` | `--primary-hover` |
| Cream (page) | `#FDF9F1` | `--background`, `--primary-foreground` |
| Brown (body text) | `#403428` | `--foreground` |
| Sand (hovered rows, muted fills) | `#F4EEE2` | `--muted`, `--accent` |
| Muted text | `#6E6052` | `--muted-foreground` |
| Borders | `#E6DDCC` | `--border`, `--input` |
| Chartreuse (accent) | `#D9E027` | `--highlight`, so `bg-highlight` and `text-highlight` |

Poppins is the only family, for body and headings alike; `font-heading` stays a separate token
so the two can split later. Buttons are sentence-case pills, not GBD's
uppercase: rows of in-app actions read faster that way. In-app headings are bold green in
sentence case, because they show user content such as report and org names. UPPERCASE headings
are for the marketing page and eyebrow labels only.

**Contrast decides where chartreuse may go.** On cream it is 1.4:1, so there it is decoration
only: never text, a focus ring or a link underline. On green it is 4.7:1 and may carry text.
GBD's own link green `#049250` is 3.8:1 on cream, which fails AA, so links use `#016939`.
`layout.css`'s header comment records the ratios.

**Decisions made with the user:** an original PLATE mark in GBD's idiom (`lib/assets/mark.svg`,
with `favicon.svg` as the disc) until GBD sends official art; Poppins everywhere; restyle the
emails and the PDF too; no screenshot pruning before the redesign.

The marketing mockup this plan follows: a cream hero with a small green uppercase eyebrow; an
uppercase, tightly tracked green headline with "climate impact" underlined by a thick chartreuse
bar; a green pill CTA with chartreuse text; then a full-bleed green "How it works" band with a
cream uppercase heading and chartreuse numbered discs.

## PR breakdown

| PR | What | Screenshots |
| --- | --- | --- |
| 1 | Web: marketing page brand treatment | 3 (`marketing`) |
| 2 | Emails: `packages/email` + Supabase auth templates | none |
| 3 | PDF report (Python) | none |

All three are independent of one another.

## PR 1: marketing page (`apps/web/src/routes/+page.svelte`)

Follow the mockup described in Context:
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

## PR 2: emails

- In `packages/email/src/messages/layout.ts`, update the styles:

  | Style | New values |
  | --- | --- |
  | `BODY_STYLE` | background `#FDF9F1`, color `#403428`; font stack `Poppins,-apple-system,…` (clients can't load webfonts reliably, so the stack falls back) |
  | `CARD_STYLE` | stays white, `border-radius:12px` |
  | `ACTION_STYLE` | `#016939` background, `#FDF9F1` text, `border-radius:999px`, sentence case like the app's buttons, weight 700. Replaces `#166534` |
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

## PR 3: PDF report (`python/insights/gbd_foodservice_insights/`)

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

**PR 1 (marketing)**
- `pnpm turbo run screenshots:update --filter=@gbd/web`; axe checks contrast on the green band
  at every viewport. Only the three `marketing` PNGs should change.
- `pnpm lint && pnpm check && pnpm test`.

**PR 2 (emails)**
- `pnpm --filter @gbd/email preview` to view every app email.
- `pnpm lint && pnpm check && pnpm test`.
- Trigger a sign-in code locally and view it in the local Supabase mail catcher.

**PR 3 (PDF)**
- `just lint && just check && just test`.
- Render a report PDF from the test fixtures that `test_pdf.py` uses, rasterize each page
  (`pdftoppm -png`), and inspect it for overflow, font fallback warnings and chart colors.
