# Switch from OpenAI to Claude

## Context

GBD wants the product off OpenAI and onto Claude, and has an Anthropic API key. We no longer have
OpenAI access.

What calls an LLM:

- **The product's categorization**, the only LLM use the worker has. It moved to Claude Sonnet 5.5
  in #753. Making it more accurate, and choosing between Claude models, is
  `categorization-accuracy.md`.
- **The lab's extraction**: PDF and tabular text to Markdown tables
  (`python/lab/gbd_foodservice_insights_lab/extraction/`), also on Claude Sonnet 5.5 now. Nothing
  in the repo reads `OPENAI_API_KEY` or imports `openai` any more.
- **The lab's entree classifier** runs on Gemini and stays there.

What is left is the wording and cost estimate that still say OpenAI.

## Decisions

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
shipped while production was still broken. The PR left is independent of
`categorization-accuracy.md`.

## PR — Provider-neutral wording and the cost estimate

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
    PR description. Once structured outputs land (`categorization-accuracy.md`, PR 1), the request
    carries a schema too, which counts as input.
  - Price cache reads using those counts.
  - The vendor becomes Anthropic, and the `openai*` function names go.
  - Replace the comment about OpenAI's 1,024-token caching minimum, and the one citing
    `MAX_TOKENS` = 30, which is now each model's `max_tokens` in `MODELS`.
- **Synthetic history:** in `packages/db/src/testing/history/telemetry.ts:84-86`, the prices and
  cached prefix become Claude's.

## Ops notes (outside the repo)

- **Left from the switch** (delete each once confirmed):
  - Make a Console workspace for production and set a monthly spend limit on it. Prompt caches and
    spend are tracked per workspace, so the lab and the eval use a different key. Both keys must be
    scoped to their workspace: an organization-wide key is a 400 without an
    `anthropic-workspace-id` header, which the client does not send.
  - In `analysis_attempt_llm_usage` for a production report, check that `served_model` is Claude,
    `cached_input_tokens > 0` after the first calls, the cost is plausible, and `truncated_calls`
    is low.
  - Check the operations and cost dashboards in Grafana, and delete the `OPENAI_API_KEY` secret.
  - Run the lab's PDF runscript on a one-page sample, to see the extraction work on Claude.
- **Rate limits:** check the org's tier for the chosen model. The worker has at most workers ×
  attempts × 3 calls in flight, which is 9 today.
- **Suggestions:**
  - Unverified gpt-4.1-mini suggestions block Claude's for the same product, because the first
    suggestion wins and `suggested_by` does not record the model.
  - Whether to clear the unverified `attempt:%` rows is GBD's call.
- **Cleaned-name reuse** will hit less at first, because Claude cleans names differently from
  gpt-4.1-mini. That costs money only, not accuracy.

## Verification

- Run `pnpm lint && pnpm check && pnpm test` for the migration and the DB tests, and
  `just lint && just check && just test`.
- Run `uv run scripts/monthly_costs.py` and check its output.
