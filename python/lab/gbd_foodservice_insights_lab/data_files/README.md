# Data files

`previously_classified_entrees.csv` and `previously_classified_weights.csv` are GBD's serving
classification caches. Both are handed out privately, never committed — see the root
[`.gitignore`](../../../../.gitignore) — and obtained out-of-band from GBD. If a file is absent,
its loader returns an empty cache and logs a warning naming this file.
