# Review cache suggestions

The worker, and later the lab, suggest rows for `product_categorization`,
`entree_classification` and `unit_weight` unverified, and only verified rows are ever used. Review
them in Supabase Studio's Table Editor; the write guard lets these edits through.

1. Open the table and filter on `is_verified = false`, sorted by `created_at`. `suggested_by` says
   where a row came from.
2. Fix `category` (or the label, or the weight) in place if it's wrong, then tick `is_verified`.
   The next worker claim and the next lab pull pick it up.
3. To verify many rows at once, run an `UPDATE` in the SQL editor.

What rejecting, deleting and correcting a suggestion mean is in
[`caches-to-supabase.md`](../../.claude/plans/caches-to-supabase.md) § Decisions.
