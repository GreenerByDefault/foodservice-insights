/** Represents the enum public.quality_check */
type QualityCheck =
  | 'outlier_line_items'
  | 'per_product_weight_bounds'
  | 'month_over_month_total_volatility'
  | 'diner_meal_count_reasonableness'
  | 'missing_internal_months'
  | 'date_distribution';

export type { QualityCheck as default };
