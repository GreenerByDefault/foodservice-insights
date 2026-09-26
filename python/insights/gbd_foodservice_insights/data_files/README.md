# Data files

Two caches, handed out privately:

- `previously_categorized_items.csv` — GBD's product-categorization cache.
- `previously_classified_entrees.csv` — the entree-detection cache, read only in serving mode.

- Obtained out-of-band from GBD; never committed.
- Missing file → the loader returns an empty cache and logs a warning.

`fonts/` is committed: the Lato and Montserrat Regular/Bold OFL files the report renders with,
registered via `font_manager.addfont` in `plotting_utils.setup_gbd_fonts()` rather than relied
on from the OS or worker image.
