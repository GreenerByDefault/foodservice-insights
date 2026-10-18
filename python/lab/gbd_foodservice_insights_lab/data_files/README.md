# Data files

Three caches, pulled from the database's verified rows by step 1 and `just pull-caches` — or,
until you hold `CACHE_DB_CONNECTION_STRING`, handed out privately. See the
[lab README](../../README.md#working-on-a-client).

- `previously_categorized_items.csv` — GBD's product-categorization cache.
- `previously_classified_weights.csv` — GBD's unit-cleaning cache of previously extracted weights.
- `previously_classified_entrees.csv` — the entree-detection cache, read only in serving mode.

- Never committed.
- Missing file → the loader returns an empty cache and logs a warning.

`gemini_models.json` is committed: the Gemini model for each lab call site.
