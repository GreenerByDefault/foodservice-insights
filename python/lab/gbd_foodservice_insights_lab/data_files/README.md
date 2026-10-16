# Data files

Three caches, handed out privately:

- `previously_categorized_items.csv` — GBD's product-categorization cache.
- `previously_classified_weights.csv` — GBD's unit-cleaning cache of previously extracted weights.
- `previously_classified_entrees.csv` — the entree-detection cache, read only in serving mode.

- Obtained out-of-band from GBD; never committed.
- Missing file → the loader returns an empty cache and logs a warning.

`gemini_models.json` is committed: the Gemini model for each lab call site.
