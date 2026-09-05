# Data files

`previously_categorized_items.csv` is GBD's product-categorization cache (~39k rows). It is
handed out privately, never committed — see the root [`.gitignore`](../../../../.gitignore) —
and obtained out-of-band from GBD. If it is absent, the loader returns an empty cache and logs
a warning naming this file.
