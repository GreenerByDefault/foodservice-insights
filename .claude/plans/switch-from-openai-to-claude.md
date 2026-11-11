# Switch from OpenAI to Claude

## Context

GBD wants the product off OpenAI and onto Claude, and has an Anthropic API key. We no longer have
OpenAI access, so nothing can be compared against gpt-4.1-mini: the verified cache is the only
ground truth.

What calls an LLM:

- **The product's categorization**, the only LLM use the worker has, now on Claude Sonnet 5.5. For
  each product the verified cache misses, `AnthropicLlmClient`
  (`python/insights/gbd_foodservice_insights/categorization/llm.py`) makes a `clean` call, then a
  `match` call unless cleaned-name reuse hits (`steps.py`). Each is a fixed, cached system prompt
  (~1,000 tokens for `clean`, ~1,160 for `match` with the 27 categories filled in, by the old
  4-characters-a-token estimate) plus `classify <name> according to your instructions`. A cache hit
  skips the LLM entirely, and an LLM answer goes back only as an unverified suggestion.
- **The lab's extraction**: PDF and tabular text to Markdown tables, still on `gpt-4o` and
  `gpt-4.1` (`python/lab/gbd_foodservice_insights_lab/extraction/`). It moves to Claude too, and
  until it does, the lab keeps `OPENAI_API_KEY` and the `openai` package.
- **The lab's entree classifier** runs on Gemini and stays there.

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

### Model: Sonnet 5.5 stays, until adjudication or the next two PRs say otherwise

| | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| $/MTok: input · cache read · output | 0.10 · 0.01 · 0.50 | 2 · 0.10 · 10 | 4 · 0.20 · 20 |
| Thinking for a one-line answer | off (`disabled`) | off (`between_tools`) | always on; `effort: low` |
| Planned: ~110k calls a month | ~$3 | ~$45 | ~$95, plus ~$22 per 10 thinking tokens a call |
| Growth: ~440k calls a month | ~$12 | ~$180 | ~$380, plus ~$88 per 10 thinking tokens a call |

**Assumptions behind the table:**
- Call volumes are `scripts/monthly_costs.py`'s scenarios.
- A call is ~1,400 input tokens, ~1,350 of them the cached system prompt. Claude's newer tokenizers
  count more than the script's 1,050; nobody has measured the real figure yet (PR 4).
- A call writes ~10 output tokens; Opus averaged ~41 with its thinking.
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
thinking at `low` effort (its `thinking` in `MODELS` set to `None`, with room in its `max_tokens`)
before moving up.

**Read now, that rule keeps Sonnet**, the only model within a point of the best. It is a weak
verdict: two points on 400 rows is eight products, inside the noise, and Sonnet swaps meats most
often, nearly all of it the pork rule. Opus is best on the meats but no better on random rows, at
3.7× Sonnet's cost. Haiku costs 14× less than Sonnet, and 11 of its 32 errors on random rows are
truncated or off-list replies, which PR 1 removes. So PRs 1 and 2 each end by re-running the eval
and applying the rule again, and Haiku is the likeliest change.

*Rejected: choosing the model with the eval before switching.* Production was down, and the eval
needed the new client anyway. Changing `DEFAULT_MODEL` between Claude models is also the rollback.

### The eval: the verified cache is the answer key, and a human settles disagreements

`python -m gbd_foodservice_insights_lab.categorization.model_eval run` (in `python/lab`) cleans and
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

### The request: the old prompts, thinking off, system prompt cached

- **The prompts are gpt-4.1-mini's, unchanged so far**, so the first eval measured the models and
  not a prompt edit. PRs 1 and 2 change them, each measured against that baseline.
- **`MODELS` maps each model id to its `ModelSettings`**: its price, how its request turns thinking
  off, and its `max_tokens`. Haiku sends `thinking={"type": "disabled"}`, Sonnet
  `{"type": "between_tools"}` (`disabled` is a 400 there), and Opus nothing, since its thinking
  cannot be turned off. All three run at `output_config={"effort": "low"}`. Haiku and Sonnet cap
  at 30 tokens; Opus at 2,000, to leave room for its thinking. `truncated` flags a reply that hits
  the cap. Trying a model with thinking on is a change to its `thinking` entry, nothing else.
- **No `temperature`.** The SDK is `anthropic` 2.x, on API version 2026-10-21, which rejects it on
  every model. Small differences from run to run are absorbed by the verified cache.
- **Refusals** raise a `ValueError` naming `stop_details.category`, which fails the run. The eval
  drew none.
- *Rejected: server-side `fallbacks`.* They retry only `cyber` and `frontier_llm` refusals, which a
  product name will not draw, and would make the served model, and so the price, vary per call.

### Telemetry: the client converts Anthropic's counts to the schema's meaning

The schema's rule is that input tokens include the cached ones. That rule is enforced in the Python
contract, the TypeScript contract, a DB CHECK, a column comment and the fixtures. Anthropic's
`input_tokens` leaves out cache reads and writes, so `_llm_call` reports:
- `input_tokens = input + cache_read + cache_creation`
- `cached_input_tokens = cache_read`

`ModelPrice.cached_input` is the cache-read price. Cache writes cost 1.25× input but are priced as
plain input, which undercounts a run by a fraction of a cent.

*Rejected: a `cache_write_input_tokens` field end to end.* It needs a migration and changes to both
contracts and the fixtures, all for a fraction of a cent per run.

### PR shape: the swap went first, because production was down

The switch itself shipped as one PR rather than behind prefactors, since each prefactor would have
shipped while production was still broken. The two accuracy PRs come next, because they decide the
model; the lab port and the wording follow, and none of the four depends on another. PR 5 waits
on GBD's answers, and only it does.

### Cache fixes: GBD rules on categories, and each ruling fixes the prompt and the whole cache

The first run's 190 disagreements, read against how GBD labeled similar products across the
whole cache:

| | Rows | What happens |
|---|---|---|
| The model is wrong | 146 | Nothing, or a prompt fix in PR 1, 2 or 5 |
| The cache is wrong, and the rule is clear | 14 | GBD approves; Eric runs the SQL |
| Cream soups: the prompt says Milk, the cache splits | 7 | GBD confirms the rule |
| Meat soups, or no rule written anywhere | 23 | GBD decides the rule |

The SQL for the 14 also fixes 8 rows outside the sample with the same errors, so 22 in all.

- **A ruling is a rule, not a row.** Each one becomes a line in the match prompt, and an `UPDATE`
  over every cached row it covers, not only the sampled ones: the cache splits on soups as a
  whole, so fixing the sample alone leaves it inconsistent.
- **The stakes are small except for meats.** 22 rows of ~41,400 barely move a report. A meat
  answered as another meat does, since beef's emission factor is ~4× pork's, and PR 2 covers it.
- **Unwritten conventions the cache follows consistently** go in the prompt without asking:
  venison → Beef, green beans → Legumes, vegan mains → Plant-based Meats, a hot dog or meatball
  naming no meat → Pork.
- **Product names stay off the repo.** The rows, with the SQL for each decision, are in
  `client_work/model_eval/2026-11-11T044246Z/fixes.sql` and `review.csv` on Eric's laptop, backed
  up outside the checkout. This plan holds only the rules.
- *Rejected: committing `fixes.sql` as a temporary file.* The repo is public, and the names come
  from customers' purchases.

## PR 1 — Structured outputs, so every answer is one category or one name

**Why:** Haiku and Sonnet sometimes reply conversationally instead of with one line: they ask for
clarification, explain a non-food item, or correct themselves mid-answer. Out of ~1,000 products
that was 57 and 50 truncated calls and 22 and 29 off-list answers. A chatty `clean` reply is worse
than an off-list `match`: cut off at 30 tokens, it becomes the cleaned name that `match` sees and
that goes back as a suggestion.

- **`match`:** `output_config.format` with a JSON schema whose answer is an `enum` of
  `category_names()` plus "No Matches Found", so an off-list answer cannot happen.
  `categorize_with_llm`'s unrecognized-answer handling stays as a guard.
- **`clean`:** a schema with one string, the cleaned name.
- **Check first** that each model accepts a format alongside its `thinking` setting, Sonnet's
  `between_tools` especially, and give `max_tokens` room for the JSON around the answer.
- **The match prompt's "Return only the category, worded exactly as it is listed"** becomes what
  the schema enforces; drop that sentence and nothing else, and leave the clean prompt's rules,
  which shape the name rather than the format.
- **Tests:** `python/insights/tests/categorization/test_llm.py`, for the request and for reading
  the answer out of the JSON.
- **Then** re-run the eval and apply the decision rule. Off-list answers should read zero and
  truncations near it.

## PR 2 — The pork rule yields to a stated meat, Halal or Kosher

**Why:** the eval's pork-rule slice found all three models doing what gpt-4.1-mini did. All three
called a Kosher meatball Pork, Haiku and Sonnet called Halal pepperoni Pork, and Sonnet called a
venison sausage and a beef meatloaf Pork. These are most of every model's meat swaps.

- **Rewrite the line** in `python/insights/gbd_foodservice_insights/prompts/match_items_to_gbd_categories_prompt.md`
  so Pork is assumed only when the product names no meat and is not Halal or Kosher, with an
  example of each.
- **Then** re-run the eval. The pork-rule slice should rise, meat swaps fall, and random-row
  accuracy must not drop.

## PR 3 — Port the lab's OpenAI extraction to Claude, and drop `openai` (lab)

- **`notebook_runscript_setup.py:468-513`:** `setup_api_clients(anthropic=...)` reads
  `ANTHROPIC_API_KEY`, and `setup_cli_environment` asks for Claude and Gemini.
- **`extraction/llm.py`:**
  - `chat.completions` calls become the Messages API: read text blocks by type, and drop
    `temperature`.
  - The experimental `responses.create` path is OpenAI-only. Delete it, and say so in the PR, as
    the lab rule asks for code a `client_work/` notebook might call.
- **`extraction/pdf.py`, `other.py`, `tabular_io.py`:**
  - The client and model constants go from `gpt-4o` and `gpt-4.1` to `claude-sonnet-5-5`; data
    scientists can tune that.
  - Keep the comparison against Gemini.
- **Runscripts:**
  - `0.5 Prepare PDF data.ipynb` moves to the Claude client.
  - `1.5. Clean Units Runscript.py:23-24` builds a client it never uses; delete it.
- **Tests:** `tests/conftest.py:25-31`, `tests/extraction/test_llm.py`,
  `tests/extraction/test_pdf.py`.
- **Remove OpenAI:**
  - Drop `openai` from `python/lab/pyproject.toml` and `uv.lock`.
  - Drop `OPENAI_API_KEY` from `.env.example` and from `LAB_ONLY` in
    `apps/worker/src/env-lists.test.ts`.
  - Drop it from `python/lab/README.md`'s list of keys the lab reads, and from
    `python/README.md`'s count of them; update `gemini.py:4`.
  - If `experiments/gemini_api_examples.py` imports `openai`, delete it.
- **Port like for like.** Letting Claude read PDFs directly could replace part of this pipeline,
  but that is a redesign.

## PR 4 — Provider-neutral wording and the cost estimate

- **A new migration** with `COMMENT ON COLUMN` for `analysis_attempt_llm_usage.served_model`,
  `.requests` and `.input_tokens`, so none says OpenAI. Regenerate `public-schema.sql` and the
  generated type; never edit migration 003.
- **Comments:**
  - `apps/worker/src/contract/messages.ts:99`
  - `worker_child/writer.py:158`
  - `apps/web/src/lib/polling/schedule.ts:24`
  - `worker_child/mock_llm.py:1-2`
- **Dashboard descriptions:** `apps/grafana/resources/dashboards/operations.yaml:71,322-323`.
- **`scripts/monthly_costs.py`:**
  - It already prices `DEFAULT_MODEL`, so it bills Sonnet today, but all of it as uncached input.
  - Measure both system prompts with `count_tokens` on `DEFAULT_MODEL`, and put the figures in the
    PR description. After PR 1 the request carries a schema too, which counts as input.
  - Price cache reads using those counts.
  - The vendor becomes Anthropic, and the `openai*` function names go.
  - Replace the comment about OpenAI's 1,024-token caching minimum, and the one citing
    `MAX_TOKENS` = 30, which is now each model's `max_tokens` in `MODELS`.
- **Synthetic history:** in `packages/db/src/testing/history/telemetry.ts:84-86`, the prices and
  cached prefix become Claude's.
- **`.claude/plans/runbooks.md:33,115,178`:** the OpenAI key mentions.

## PR 5 — Write GBD's rulings into the match prompt (blocked on GBD)

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
- No code changes beyond the prompt.

**Data, by hand in the SQL editor** per `docs/runbooks/write-to-the-database-by-hand.md`:
- First the approved decisions 1–4 from `fixes.sql`.
- Then one guarded `UPDATE` per ruling over every verified row it covers, generated from the
  pulled cache, checked by Eric before running.

**Then** `just pull-caches`, re-score the first run with `score`, and re-run the eval on the new
prompt. The soup slice should rise, and random-row accuracy must not drop.

## Ops notes (outside the repo)

- **Before the switch merges:**
  - Make a Console workspace for production and set a monthly spend limit on it. Prompt caches and
    spend are tracked per workspace, so the lab and the eval use a different key. Both keys must be
    scoped to their workspace: an organization-wide key is a 400 without an
    `anthropic-workspace-id` header, which the client does not send.
  - Add `ANTHROPIC_API_KEY` to the GitHub `production` environment. `deploy-service` fails on an
    unset `${NAME}`.
  - Run a `WORKER_MODE=live` worker on a laptop with `ANTHROPIC_API_KEY` on a small upload,
    following `apps/worker/README.md` § The categorization cache so its suggestions stay out of
    the shared cache. Include "Beef sausages" and a Halal meatball. In
    `analysis_attempt_llm_usage`, check that `served_model` is Claude, `cached_input_tokens > 0`
    after the first calls, the cost is plausible, and `truncated_calls` is low (PR 1 takes it to
    zero).
- **After it deploys:** run one real report in production, check the operations and cost
  dashboards in Grafana, and delete the `OPENAI_API_KEY` secret.
- **Adjudication:** the first run's 190 disagreements are reviewed, and `fixes.sql` is ready to
  send to GBD (see § Cache fixes). Waiting on GBD: approval of decisions 1–4 and rulings on
  questions 5–9. Record here the date it went out, and nudge after two weeks.
- **Rate limits:** check the org's tier for the chosen model. The worker has at most workers ×
  attempts × 3 calls in flight, which is 9 today.
- **Suggestions:**
  - Unverified gpt-4.1-mini suggestions block Claude's for the same product, because the first
    suggestion wins and `suggested_by` does not record the model.
  - Whether to clear the unverified `attempt:%` rows is GBD's call.
- **Cleaned-name reuse** will hit less at first, because Claude cleans names differently from
  gpt-4.1-mini. That costs money only, not accuracy.

## Verification

**PRs 1, 2 and 5:**
- Run `just lint && just check && just test`.
- Run the eval and put its `report.md` in the PR description, beside the baseline table above.

**PR 3:**
- Run `just lint && just check && just test && TEST_DB=1 just test-lab`.
- Run a PDF runscript on a one-page sample.

**PR 4:**
- Run `pnpm lint && pnpm check && pnpm test` for the migration and the DB tests, and
  `just lint && just check && just test`.
- Run `uv run scripts/monthly_costs.py` and check its output.
