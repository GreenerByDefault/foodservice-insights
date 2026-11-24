# Categorization: GBD's rulings

## Context

Categorization runs on Claude Sonnet 5.5. For each product the verified cache misses,
`AnthropicLlmClient` (`python/insights/gbd_foodservice_insights/categorization/llm.py`) makes a
`clean` call and a `match` call with the prompts in `python/insights/gbd_foodservice_insights/prompts/`,
and the answer goes back to GBD as an unverified suggestion. `model_eval` scores that path end to
end against the verified cache; its module docstring says how to run it.

What is left needs GBD. The cache labels some kinds of product two ways (chicken soups, 58 to 44);
the match prompt contradicts itself on clam chowder and is silent on bean soups, vegan mains and
products that name two meats; and #801 added three rules GBD never stated. Until GBD rules, the
eval cannot tell a model's error from the cache's on those rows, and no prompt can agree with a
cache that disagrees with itself.

The questions are written up for GBD in `python/lab/client_work/gbd_rulings/questions-for-gbd.md`,
to paste into a Google Doc, with `rows.csv` beside it. Both name customers' products, so they stay
in the gitignored `client_work/`, backed up outside the checkout. The repo is public: this plan
holds question IDs and rules, never a product name, and only aggregate eval numbers go in a PR.

## Decisions

### GBD answers in a Google Doc, keyed by ID

- **The doc is written for GBD, not for us.** It opens with one table of answers, each with our
  recommendation, then gives every question its options and evidence from GBD's own labels. It
  says "your verified product list" and "Claude's instructions", never cache or prompt.
- **Every answer has an ID** that § Ruling map turns into a change: S1–S4 soups, M1–M3 meats,
  V1–V4 plant-based dishes, C1–C4 patterns to confirm, F1–F3 batches of single-row fixes, and
  P1–P6 products only GBD can identify.
- **A row is keyed by its ID, never its name.** Google Docs collapses runs of spaces, and some
  product names have them. `rows.csv` maps each F and P ID to the exact product and its current
  category; P4 is two rows, `P4a` and `P4b`.
- **The counts quoted to GBD are approximate:** regexes over product names in the cache as pulled
  on 2026-11-22, and the doc says so. The SQL is exact, because Eric reads it row by row (§ PR 1).
- *Rejected: sending GBD the first run's `fixes.sql`.* Its questions sat in SQL comments, so
  approving a row meant reading SQL.

### A ruling is a rule, not a row

Each ruling becomes a line in a prompt and an `UPDATE` over every verified row it covers, not only
the sampled ones. The cache splits on these kinds of product throughout, so fixing the sample alone
leaves it inconsistent, and the next eval argues the same question again.

### Rules GBD has not stated stay live until they answer

#801 extended GBD's pork default (meatballs, sausages and meat loaf naming no meat) to hot dogs,
pepperoni and salami; made a Halal or Kosher product naming no meat Beef; and made venison Beef.
Each matches GBD's labels, so reverting one would make the prompt disagree with the cache. M2, M3
and C1 put them to GBD. M2 rests on three rows and chooses between factors 9× apart, so it is the
likeliest to change.

M3 also asks about GBD's own default. US meat loaf and meatballs are often beef, which a pork
default understates ~4×. GBD wrote that rule, so we ask rather than change it.

### The eval sees only rows where a model disagrees

Rows where every model agrees with a wrong cache are never shown to anyone. A scan of the whole
cache for words that mislead (a beef tomato, buffalo sauce, a mince pie, a hamburger bun, a flavor
in a biscuit's name) found six wrong rows the sample never drew; they are in F1.

### The eval measures each PR, and a point on random rows is noise

- **The baseline** is the run in `client_work/model_eval/2026-11-23T044156Z/`, on the prompts as of
  #801. After the data fixes, `score` it again at no cost, so the before-numbers are against the
  fixed cache.
- **What should move:** the soup and plant_based slices and the meat swaps. Random-row accuracy
  must not drop by more than a point, nor by any amount that the rows which moved don't explain.
  Between two near-identical runs, Haiku changed 68 of 1,012 answers and Sonnet 27, each fixing
  about as many as it broke.
- **The model rule re-applies on every prompt change:** the cheapest model within one point of the
  best random-row accuracy that swaps one meat for another no more often than the best model.
  Sonnet holds it today: Haiku is 1.8 points behind and swaps three meats to Sonnet's one, with or
  without adaptive thinking. If Haiku falls short only on the swaps, retry it once with `thinking`
  set to `{"type": "adaptive"}` in `MODELS` before ruling it out.
- **A prompt's examples are generic names, never products from the cache.** One would leak the
  answer key into the eval, and put a customer's product name in a public repo.
- **A match rule is only as good as the cleaned name it sees.** Check in the eval's `answers/`
  that the clean call keeps the words a new rule relies on. C3 is that kind of fix: the clean call
  turns some pureed meals into "babyfood", and the match call then answers No Matches Found.

## Ruling map

For each ID, what PR 1 changes. "Match prompt" and "clean prompt" are the two files in `prompts/`.
An answer in GBD's own words becomes a prompt line in their words. Where it is ambiguous, or
conflicts with another answer, ask Eric rather than guess. Every `UPDATE` covers all verified rows
the rule reaches.

**Soups.** All four rewrite the match prompt's soup line, which today gives clam chowder as an
example of No Matches Found and also makes a cream-based soup Milk.
- **S1, soups with meat in them.** A: No Matches Found, as the line says now; rows labeled with
  the meat go to No Matches Found. B: a soup naming a meat is that meat; rows go the other way.
- **S2, broths, stocks and bases naming a meat.** A: keep "soup bases" in the line; rows labeled
  with the meat go to No Matches Found. B: they follow the meat.
- **S3, cream soups.** A: a soup named cream, bisque, New England chowder or broccoli cheddar is
  Milk, and the No Matches Found example becomes a clam chowder that says neither. Rows go to Milk,
  seafood bisques included unless GBD says to keep them Shellfish. B: drop the Milk exception;
  Milk-labeled soups go to No Matches Found.
- **S4, bean, lentil and split pea soups.** A: Legumes, minestrone excepted; rows go to Legumes.
  B: No Matches Found.

**Meat.** All three edit the match prompt's pork-default bullet.
- **M1, two meats.** A: a pork-and-beef sausage, hot dog, pepperoni or salami is Pork; anything
  else naming beef alongside another meat is Beef. The cache already does this. B: anything naming
  beef is Beef. C: the first meat named.
- **M2, Halal or Kosher naming no meat.** A: no change. B: Poultry in the sub-bullet, and the rows.
- **M3, the pork default.** A: no change. B: Beef for meat loaf, meatballs and hot dogs naming no
  meat. That moves ~130 rows from Pork to Beef, the largest data change here.

**Plant-based dishes.**
- **V1, vegan and vegetarian mains naming no protein.** A: a line making them Plant-based Meats,
  and Legumes when they name a legume; rows labeled No Matches Found go to Plant-based Meats.
  B: No Matches Found unless the protein is named.
- **V2, bean burgers.** A: next to the Plant-based Meats examples, a bean burger is Legumes and a
  vegetable burger or cutlet Plant-based Meats. B: every veggie burger is Plant-based Meats.
- **V3, vegetable lasagna.** A: Cheese, next to the pizza line. B: No Matches Found.
- **V4, PB&J.** A: Legumes, next to the peanut butter desserts line. B: No Matches Found.

**Patterns to confirm.** On a "no", GBD's answer is the rule instead.
- **C1, venison is Beef.** Yes: no change; it is live.
- **C2, plain green beans are Legumes.** Yes: add them to the Legumes examples.
- **C3, pureed meals keep their meat; jarred baby food does not.** Yes: in the clean prompt, the
  "babyfood" rule covers jarred baby food only. A pureed or texture-modified meal (puree, minced,
  IDDSI or "Level" numbers), pediatric ones included, keeps its meat.
- **C4, a meat pizza is Cheese.** Yes: the pizza line says so, and that a topping sold on its own
  is its meat; meat-labeled pizzas go to Cheese.

**Single rows**, from `rows.csv`.
- **F1–F3:** an approved row's `correct_category` is its `proposed_category`. A row GBD wrote a
  category against takes that category, and a row rejected without one is left out. Where a row
  follows from a ruling (F1.3 and F2.7 from C4, F3.2–F3.5 from M3, F3.6 from V2), the ruling wins.
- **P1–P6:** what GBD writes may be a description, not a category. Propose the category, and Eric
  confirms it.

## PR 1 — Write GBD's rulings into the prompts (blocked on GBD)

**Why:** the eval's soup and plant-based slices mean little until GBD picks the rules, and the
cache disagrees with itself on the rows those rules cover.

1. **Read the answers.** Eric exports the Google Doc as Markdown (File → Download → Markdown) to
   `client_work/gbd_rulings/answers.md`. Map each ID through § Ruling map, and list anything
   unanswered, ambiguous or conflicting for Eric before changing anything.
2. **Fix the data first.** Copy `rows.csv` and add the `correct_category` column `fixes` reads,
   filled per § Ruling map. Then add one row
   per verified row each ruling covers, generated from the pulled cache with the same columns.
   Eric reads the whole list. `model_eval fixes` turns it into one guarded `UPDATE`, which Eric
   runs per `docs/runbooks/write-to-the-database-by-hand.md`, then `just pull-caches`.
3. **Re-baseline.** `score` the baseline run against the fixed cache.
4. **Write the rules into the prompts,** with generic examples.
5. **Run the eval** on Haiku and Sonnet, and judge it against step 3 per § The eval measures each
   PR.

If GBD answers in batches, ship a PR per batch.

## Ops notes (outside the repo)

- **The questions** are ready and not yet sent. Record here the date they go out, and nudge after
  two weeks.
- **Eval spend:** a run of Haiku and Sonnet is about $1. Opus adds ~$2.60, and
  `run --models claude-haiku-5-5 claude-sonnet-5-5` leaves it out.

## Verification

- Run `just lint && just check && just test`.
- Put the eval's `report.md` in the PR description beside the re-baselined numbers from step 3.
