# Categorization accuracy

## Context

Categorization runs on Claude Sonnet 5.5 since #753. For each product the verified cache misses,
`AnthropicLlmClient` (`python/insights/gbd_foodservice_insights/categorization/llm.py`) makes a
`clean` call, then a `match` call unless cleaned-name reuse hits (`steps.py`). A cache hit skips
the LLM entirely, and an LLM answer goes back only as an unverified suggestion for GBD to review.

This plan makes those answers more accurate and settles which Claude model gives them. The
measure is `model_eval`, which scores each model against the verified cache, and where the two
disagree, the cache is sometimes what is wrong. So it also settles with GBD the rules the cache and
the prompt should both follow.

The repo is public. The cache CSVs are gitignored and have never been committed, and that stays
true: eval data stays on a laptop and only aggregate numbers go in a PR.

## What the verified cache says about difficulty

The pulled cache holds 41,428 verified product rows and 2,342 entree rows, from the Oct 25 import
of GBD's final files plus the fixes below. GBD's cleanups are in them: the 58 entree flips, the 512
restored entree rows with their final labels, and 35 Pork→Beef fixes in the product cache.

- **The categories:** 60% of rows are "No Matches Found". The rest spread over 26 categories, all
  of them on the taxonomy.
- **The hard cases are rare but expensive:**
  - Rows by kind: 538 Kosher or Halal, 523 meatballs or sausages, 495 vegan, plant-based or Quorn,
    604 soups, and 136 texture-modified ("Level 4").
  - **The pork rule:** the match prompt says "assume meatballs, sausages and meat loaf is Pork
    unless otherwise stated", and gpt-4.1-mini applied it even when the meat *was* stated, or the
    product was Halal. 16 such rows survived GBD's cleanup labeled Pork; they were corrected to
    Beef or Poultry in production on 2026-11-10, with the eval's `fixes` command.
  - **What it costs a report:** beef's emission factor is ~4× pork's, so each such row understates
    the report's emissions.
- **So the cache is not perfect gold.** Where a model disagrees with it, the cache may be what is
  wrong. The eval sends those rows to a human instead of counting them as model errors.
- **Cleaned names are not gold at all.** 20,483 rows have the product name as their cleaned name,
  and 3,053 have none. The eval scores the category, end to end.
- **The entree sheet shows the same kind of judgment:** jacket-potato toppers versus filling pots,
  UK puddings, pack sizes (19 rows changed and 8 borderline, out of 512). That belongs to the
  Gemini classifier, not to this plan.

## Decisions

### Model: Sonnet 5.5 stays, and every prompt change re-applies the rule

| | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| $/MTok: input · cache read · output | 0.10 · 0.01 · 0.50 | 2 · 0.10 · 10 | 4 · 0.20 · 20 |
| Thinking for a one-line answer | off (`disabled`) | off (`between_tools`) | always on; `effort: low` |
| Planned: ~110k calls a month | ~$3 | ~$35 | ~$71, plus ~$22 per 10 thinking tokens a call |
| Growth: ~440k calls a month | ~$11 | ~$142 | ~$283, plus ~$88 per 10 thinking tokens a call |

**Assumptions behind the table:**
- Call volumes are `scripts/monthly_costs.py`'s scenarios.
- A call is ~1,670 input tokens, all but 29 of them the cached system prompt: `count_tokens` on
  Sonnet 5.5 gives 1,402 for `clean` and 1,930 for `match`. Haiku and Opus were not measured.
- A call writes ~10 output tokens; Opus averaged ~41 with its thinking. Structured outputs, which
  wrap each answer in JSON, have since raised the eval's cost per product by ~25% on Haiku and
  Sonnet, so read their rows as ~25% low.
- Prices are Anthropic's list as of 2026-11-10, the date `MODELS` cites. Re-check them on the day.
- For comparison, gpt-4.1-mini cost ~$48 under Planned, uncached.

**What the eval measured**, on 1,012 products, before anyone adjudicated its disagreements:

| | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| Accuracy, 400 random rows | 92.0% | 94.0% | 92.0% |
| Accuracy, 159 pork-rule rows | 94.3% | 92.5% | 96.9% |
| A meat answered as another meat | 5 | 8 | 3 |
| Off-list answers | 22 | 29 | 3 |
| Truncated calls | 57 | 50 | 0 |
| USD per 1,000 products | $0.05 | $0.71 | $2.61 |

**The decision rule**, written down before the run: pick the cheapest model within one point of
the best adjudicated accuracy on random rows that swaps one meat for another no more often than the
best model does. If Haiku falls short only on the meat slices, try it once more with adaptive
thinking at `low` effort (its `thinking` in `MODELS` set to `{"type": "adaptive"}`, with room in
its `max_tokens`) before moving up.

**Since then**, two re-runs on the same 1,012 products: after structured outputs, then after the
pork rule (both § The request). All three runs are scored against the cache as re-pulled on
2026-11-22. Opus was left out, since it had no format failures to remove and costs 3.7× Sonnet:

| First run → structured outputs → pork rule | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| Accuracy, 400 random rows | 92.0% → 93.2% → 93.0% | 94.0% → 94.8% → 94.8% |
| Accuracy, 159 pork-rule rows | 94.3% → 92.5% → 97.5% | 92.5% → 96.2% → 99.4% |
| A meat answered as another meat | 5 → 8 → 3 | 8 → 5 → 1 |
| Off-list answers | 22 → 0 → 0 | 29 → 0 → 0 |
| Truncated calls | 57 → 0 → 0 | 50 → 0 → 0 |
| USD per 1,000 products | $0.05 → $0.07 → $0.07 | $0.71 → $0.89 → $0.93 |

**The rule keeps Sonnet.** Haiku is within two points of it on random rows and swaps three meats to
Sonnet's one, and with adaptive thinking, the one retry the rule allows, it still swapped three
(93.5% random, 97.5% pork rule, $0.08 per 1,000). Two of Haiku's swaps are its clean call's doing,
in both runs: it drops "beef" from a beef meatloaf, and reads a run-together brand name as "halal".
Sonnet's one is a chicken-and-beef meatball, and the cache itself splits on mixed meats.

**A point on random rows is noise.** Between the structured-outputs run and the first run of the
pork rule, Haiku changed 68 of 1,012 answers and Sonnet 27, each fixing about as many as it broke.
Sonnet's random rows dipped to 94.0% there, on a nutrition shake, green beans, a lentil soup and a
chicken tortilla, which the rule does not touch, then came back to 94.8% on a re-run that changed
only one example's wording. So "random-row accuracy must not drop" means no drop beyond a point,
or a drop traced to the change in the rows that moved.

*Rejected: choosing the model with the eval before switching.* Production was down, and the eval
needed the new client anyway. Changing `DEFAULT_MODEL` between Claude models is also the rollback.

### The eval: the verified cache is the answer key, and a human settles disagreements

`uv run python -m gbd_foodservice_insights_lab.categorization.model_eval run` cleans and
matches ~1,000 cached products with each model in `MODELS`, exactly as the product does for a cache
miss, and writes everything to a new `python/lab/client_work/model_eval/<UTC time>/`. The sample is
400 random rows, up to 100 of each hard slice, and every product the pork rule covers but should not
apply to. That last slice is keyed on the name, not the label, so it survives the cache being fixed.

A disagreement is a question, not a score. A reviewer fills `correct_category` in
`disagreements.csv` where the cache is wrong; `fixes` turns that into one guarded `UPDATE` for
Supabase Studio's SQL editor; after `just pull-caches`, `score DIR` re-scores the saved answers at no
cost. Only `report.md` holds no product names, so only it goes in a PR.

Every change to a prompt or to the request re-runs it, and applies the decision rule above. Its
blind spot: rows where every model agrees with a wrong cache are never shown to anyone.

### The request: the old prompts, thinking off, a structured answer, system prompt cached

- **The prompts are gpt-4.1-mini's, plus two measured changes**, so the first eval measured the
  models and not a prompt edit. The match prompt lost "Return only the category, worded exactly as
  it is listed", which the schema now enforces. Its pork default now applies only to a meatball,
  sausage or the like that names no meat and is not Halal or Kosher; one that is, and names no
  meat, is Beef, as is venison, which is what the cache does every time.
- **A match rule is only as good as the cleaned name it sees.** Sonnet's clean call dropped
  "halal" and "kosher", so the match call never saw them; the clean prompt now keeps them. A new
  match rule checks, in the eval's `answers/`, that the clean call keeps the words it relies on.
- **A prompt's examples are generic names, never products from the cache.** One would leak the
  answer key into the eval, and put a customer's product name in a public repo.
- **Every answer is a one-field JSON object** (`output_config.format`): `match` answers
  `{"category": ...}` from an `enum` of the categories it is given plus "No Matches Found", and
  `clean` answers `{"name": ...}`. A conversational reply cannot happen, and a reply cut off at
  `max_tokens` is not valid JSON, so it raises a `ValueError`, which fails a product run and the
  eval counts as an error. `categorize_with_llm`'s unrecognized-answer handling stays as a guard
  for other `LlmClient`s.
- **`MODELS` maps each model id to its `ModelSettings`**: its price, how its request turns thinking
  off, and its `max_tokens`. Haiku sends `thinking={"type": "disabled"}`, Sonnet
  `{"type": "between_tools"}` (`disabled` is a 400 there), and Opus nothing, since its thinking
  cannot be turned off. All three run at `effort: low`. Haiku and Sonnet cap at 100 tokens, room
  for the JSON around a name; Opus at 2,000, to leave room for its thinking. `LlmCall.truncated`
  flags a reply that hits the cap. Trying a model with thinking on is a change to its `thinking`
  entry, nothing else.
- **No `temperature`.** The SDK is `anthropic` 2.x, on API version 2026-10-21, which rejects it on
  every model. Small differences from run to run are absorbed by the verified cache.
- **Refusals** raise a `ValueError` naming `stop_details.category`, which fails the run. Neither
  eval run drew one, nor a truncated call, nor a 400 from a format beside `thinking`.
- *Rejected: server-side `fallbacks`.* They retry only `cyber` and `frontier_llm` refusals, which a
  product name will not draw, and would make the served model, and so the price, vary per call.

### Cache fixes: GBD rules on categories, and each ruling fixes the prompt and the whole cache

The first run's 190 disagreements, read against how GBD labeled similar products across the
whole cache:

| | Rows | What happens |
|---|---|---|
| The model is wrong | 146 | Nothing, or a prompt fix |
| The cache is wrong, and the rule is clear | 14 | GBD approves; Eric runs the SQL |
| Cream soups: the prompt says Milk, the cache splits | 7 | GBD confirms the rule |
| Meat soups, or no rule written anywhere | 23 | GBD decides the rule |

The SQL for the 14 also fixes 8 rows outside the sample with the same errors, so 22 in all.

- **A ruling is a rule, not a row.** Each one becomes a line in the match prompt, and an `UPDATE`
  over every cached row it covers, not only the sampled ones: the cache splits on soups as a
  whole, so fixing the sample alone leaves it inconsistent.
- **The stakes are small except for meats.** 22 rows of ~41,400 barely move a report. A meat
  answered as another meat does, since beef's emission factor is ~4× pork's, and the
  pork rule now covers it.
- **Unwritten conventions the cache follows consistently** go in the prompt without asking:
  green beans → Legumes, vegan mains → Plant-based Meats. Venison → Beef, and Pork for a hot dog or
  meatball naming no meat, are already there.
- **Product names stay off the repo.** The rows, with the SQL for each decision, are in
  `client_work/model_eval/2026-11-11T044246Z/fixes.sql` and `review.csv` on Eric's laptop, backed
  up outside the checkout. This plan holds only the rules.
- *Rejected: committing `fixes.sql` as a temporary file.* The repo is public, and the names come
  from customers' purchases.

### PR shape: one change per PR, each measured by the eval

What is left waits on GBD, so nothing here is ready to start until they answer.

## PR 1 — Write GBD's rulings into the match prompt (blocked on GBD)

**Why:** the eval's soup slice means little until GBD picks a rule, and the cache follows
conventions the prompt never states. Each ruling below needs a line in the prompt and a SQL pass
over the whole cache.

**Questions sent to GBD,** with the cache's current split:
- **Cream soups:** Milk, as the prompt says? Of 95, 46 are Milk and 40 No Matches Found.
- **Chicken and other meat soups, and soup bases:** No Matches Found, as the prompt says, or the
  meat? Of 119 chicken soups, 61 are No Matches Found and 53 Poultry; bases mostly follow the meat.
- **Bean and lentil soups:** Legumes? 26 of 29 already are; the prompt is silent.
- **PB&J sandwiches:** Legumes or No Matches Found? 38 to 84.
- **Vegetable lasagna:** Cheese or No Matches Found? 7 to 20.
- **Seven single products**, listed in `fixes.sql` with our guess for each.

**Code:**
- `python/insights/gbd_foodservice_insights/prompts/match_items_to_gbd_categories_prompt.md`:
  each ruling, plus the unwritten conventions in § Cache fixes.
- The clean prompt, only where a ruling relies on a word its clean call drops.

**Data, by hand in the SQL editor** per `docs/runbooks/write-to-the-database-by-hand.md`:
- First the approved decisions 1–4 from `fixes.sql`.
- Then one guarded `UPDATE` per ruling over every verified row it covers, generated from the
  pulled cache, checked by Eric before running.

**Then** `just pull-caches`, re-score the pork-rule run with `score`, and re-run the eval on the new
prompt. The soup slice should rise, and random-row accuracy must not drop (§ Model).

## Ops notes (outside the repo)

- **Adjudication:** the first run's 190 disagreements are reviewed, and `fixes.sql` is ready to
  send to GBD (see § Cache fixes). Waiting on GBD: approval of decisions 1–4 and rulings on
  questions 5–9. Record here the date it went out, and nudge after two weeks.
- **Eval spend:** a run is ~6,000 calls, about $3.40 across the three models, nearly all of it
  Opus. `run --models claude-haiku-5-5 claude-sonnet-5-5` skips it.

## Verification

For each PR:
- Run `just lint && just check && just test`.
- Run the eval and put its `report.md` in the PR description, beside the pork-rule column of the
  table in § Model.
