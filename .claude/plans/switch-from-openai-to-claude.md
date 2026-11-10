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

`just pull-caches` wrote 41,399 verified product rows and 2,342 entree rows. Both are unchanged
since the Oct 25 import of GBD's final files. GBD's cleanups are in them: the 58 entree flips, the
512 restored entree rows with their final labels, and 35 Pork→Beef fixes in the product cache.

- **The categories:** 60% of rows are "No Matches Found". The rest spread over 26 categories, all
  of them on the taxonomy.
- **The hard cases are rare but expensive:**
  - Rows by kind: 538 Kosher or Halal, 523 meatballs or sausages, 495 vegan, plant-based or Quorn,
    604 soups, and 136 texture-modified ("Level 4").
  - **Still labelled Pork after GBD's cleanup:**
    - 5 Halal rows, such as "Aminah Halal Slicd Beef Pepperoni" and "Chicken Meatballs in Tomato
      Sauce Halal PC".
    - 13 rows that name beef, chicken or turkey and no pork, such as "Beef sausages" and "Hot Dog
      Beef Frankfurter".
  - **Why:** the match prompt says "assume meatballs, sausages and meat loaf is Pork unless
    otherwise stated", and gpt-4.1-mini applied it even when the meat *was* stated.
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

### Model: Sonnet 5.5 ships, and the eval decides whether Haiku 5.5 is enough

| | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| $/MTok: input · cache read · output | 0.10 · 0.01 · 0.50 | 2 · 0.10 · 10 | 4 · 0.20 · 20 |
| Thinking for a one-line answer | off (`disabled`) | off (`between_tools`) | always on; `effort: low` |
| Planned: ~110k calls a month | ~$3 | ~$45 | ~$95, plus ~$22 per 10 thinking tokens a call |
| Growth: ~440k calls a month | ~$12 | ~$180 | ~$380, plus ~$88 per 10 thinking tokens a call |

**Assumptions behind the table:**
- Call volumes are `scripts/monthly_costs.py`'s scenarios.
- A call is ~1,400 input tokens, ~1,350 of them the cached system prompt. Claude's newer tokenizers
  count more than the script's 1,050; nobody has measured the real figure yet (PR 3).
- A call writes ~10 output tokens.
- Prices are Anthropic's list as of 2026-11-10, the date `MODELS` cites. Re-check them on the day.
- For comparison, gpt-4.1-mini cost ~$48 under Planned, uncached.

**Why Sonnet:**
- The meat categories drive a report's emissions, so accuracy on them is what matters.
- Speed does not matter here.
- With prompt caching, Sonnet costs about what gpt-4.1-mini did.

Haiku costs ~15× less, so we adopt it if the eval shows it is as accurate.

Opus is worth it only if it alone gets the meat cases right. A one-word answer rarely needs its
reasoning, and because its thinking cannot be turned off, its bill follows how much it thinks.

*Rejected: choosing the model with the eval before switching.* Production was down, and the eval
needed the new client anyway. Changing `DEFAULT_MODEL` between Claude models is also the rollback.

### The request: the old prompts, thinking off, system prompt cached

- **The prompts are gpt-4.1-mini's, unchanged**, so the eval measures the model and not a prompt
  edit.
- **`MODELS` maps each model id to its `ModelSettings`**: its price, how its request turns thinking
  off, and its `max_tokens`. Haiku sends `thinking={"type": "disabled"}`, Sonnet
  `{"type": "between_tools"}` (`disabled` is a 400 there), and Opus nothing, since its thinking
  cannot be turned off. All three run at `output_config={"effort": "low"}`. Haiku and Sonnet cap
  at 30 tokens; Opus at 2,000, to leave room for its thinking. `truncated` flags a reply that hits
  the cap. Trying a model with thinking on is a change to its `thinking` entry, nothing else.
- **No `temperature`.** The SDK is `anthropic` 2.x, on API version 2026-10-21, which rejects it on
  every model. Small differences from run to run are absorbed by the verified cache.
- **Refusals** raise a `ValueError` naming `stop_details.category`, which fails the run.
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
shipped while production was still broken. Wording, the cost estimate, the eval and the lab port
follow in their own PRs, and none depends on another.

## PR 1 — Evaluate the three models on the verified cache, and adopt the winner (lab)

**Code:** `python/lab/gbd_foodservice_insights_lab/categorization/model_eval.py`, run with
`uv run python -m gbd_foodservice_insights_lab.categorization.model_eval`.

**Input:** the pulled cache, read through `product_cache.read_categorization_cache_csv()`. The eval
refuses to run without it.

**Sample, ~900 products with a fixed seed:**
- Each hard slice above, capped at 100 rows.
- Every row that names a non-pork meat but is labelled Pork.
- 400 random rows.

**Run:**
- For each model in `MODELS`, an `AnthropicLlmClient(model=...)`: `clean_product_name`, then
  `match_product_to_category(category_names())`.
- Calls run on `map_concurrently` (`utils.py`).
- No cache lookups, because the cache is the answer key.

**Report per model:**
- accuracy overall and per slice
- off-list answers
- refusals
- truncations
- cost per 1,000 products, from the summed `LlmCall`s through `cost_micro_usd`
- the top confusion pairs

**Disagreements:**
- Write them, row by row, to `python/lab/client_work/model_eval/`, which is gitignored.
- A GBD reviewer adjudicates them. Where the cache is wrong, they fix it in Supabase Studio, and
  the row counts for the model.

**Decision rule, written down before running:**
- Pick the cheapest model within one point of the best adjudicated accuracy that swaps one meat for
  another no more often than the best model does.
- If Haiku falls short only on the meat slices, try it once more with adaptive thinking at `low`
  effort (its `thinking` in `MODELS` set to `None`, with room in its `max_tokens`) before moving
  up.

**Adopt:** change `DEFAULT_MODEL` if the pick is not Sonnet.

**PR description:** the aggregate table only, with no product names.

**Spend:** ~5,400 calls. About $0.10 on Haiku, ~$1 on Sonnet and a few dollars on Opus.

**Tests:** `python/lab/tests/categorization/test_model_eval.py` covers sampling and scoring on a
hand-built frame with `KeywordLlmClient`, with no network.

## PR 2 — Port the lab's OpenAI extraction to Claude, and drop `openai` (lab)

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

## PR 3 — Provider-neutral wording and the cost estimate

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
    PR description.
  - Price cache reads using those counts.
  - The vendor becomes Anthropic, and the `openai*` function names go.
  - Replace the comment about OpenAI's 1,024-token caching minimum, and the one citing
    `MAX_TOKENS` = 30, which is now each model's `max_tokens` in `MODELS`.
- **Synthetic history:** in `packages/db/src/testing/history/telemetry.ts:84-86`, the prices and
  cached prefix become Claude's.
- **`.claude/plans/runbooks.md:33,115,178`:** the OpenAI key mentions.

## Ops notes (outside the repo)

- **Before the switch merges:**
  - Make a Console workspace for production and set a monthly spend limit on it. Prompt caches and
    spend are tracked per workspace, so the lab and the eval use a different key.
  - Add `ANTHROPIC_API_KEY` to the GitHub `production` environment. `deploy-service` fails on an
    unset `${NAME}`.
  - Run a `WORKER_MODE=live` worker on a laptop with `ANTHROPIC_API_KEY` on a small upload,
    following `apps/worker/README.md` § The categorization cache so its suggestions stay out of
    the shared cache. Include "Beef sausages" and a Halal meatball. In
    `analysis_attempt_llm_usage`, check that `served_model` is Claude, `cached_input_tokens > 0`
    after the first calls, the cost is plausible, and `truncated_calls = 0`.
- **After it deploys:** run one real report in production, check the operations and cost
  dashboards in Grafana, and delete the `OPENAI_API_KEY` secret.
- **Rate limits:** check the org's tier for the chosen model. The worker has at most workers ×
  attempts × 3 calls in flight, which is 9 today.
- **Suggestions:**
  - Unverified gpt-4.1-mini suggestions block Claude's for the same product, because the first
    suggestion wins and `suggested_by` does not record the model.
  - Whether to clear the unverified `attempt:%` rows is GBD's call.
- **Cleaned-name reuse** will hit less at first, because Claude cleans names differently from
  gpt-4.1-mini. That costs money only, not accuracy.

## After this plan

- **The pork rule:** if the eval shows the match prompt's "assume Pork unless otherwise stated"
  misfiring on Claude too, change that line next and measure it with the same eval.
- **Structured outputs:** an enum of the 27 categories plus "No Matches Found" would make an
  off-list match impossible. It is worth doing only if the eval counts off-list answers.

## Verification

**PR 1:** run `just lint && just check && TEST_DB=1 just test-lab`, then the eval itself.

**PR 2:**
- Run `just lint && just check && just test && TEST_DB=1 just test-lab`.
- Run a PDF runscript on a one-page sample.

**PR 3:**
- Run `pnpm lint && pnpm check && pnpm test` for the migration and the DB tests, and
  `just lint && just check && just test`.
- Run `uv run scripts/monthly_costs.py` and check its output.
