# Review cache suggestions

The worker and the lab both add rows to `product_categorization` and `entree_classification` as
unverified suggestions. Review them in [Supabase](https://supabase.com/dashboard/projects) → the
production project → Table Editor.

1. Open the table, filter on `is_verified = false`, and sort by `created_at`. `suggested_by` says
   where a row came from.
2. If `category` (or the label) is wrong, fix it in place, then tick `is_verified`. The next
   worker claim and the next lab pull pick up the row.
3. To verify many rows at once, run an `UPDATE` in the SQL Editor.

Only verified rows are ever used, and the first suggestion for a key wins. To reject a
suggestion, leave it unverified; to have it suggested again, delete it.
