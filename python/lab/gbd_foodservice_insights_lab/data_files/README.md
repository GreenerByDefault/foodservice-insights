# Data files

`previously_classified_entrees.csv` and `previously_classified_weights.csv` — GBD's serving
classification caches.

- Obtained out-of-band from GBD; never committed.
- Missing file → its loader returns an empty cache and logs a warning.
