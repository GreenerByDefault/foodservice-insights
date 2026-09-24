This is catering data I have extracted from a CBORD "7-Day Item Usage Report".

Please reformat this text into a markdown table I can later read into python as a dataframe. Only output a markdown table of the data and nothing else. Do not explain the output, just return it. DO NOT return in a codeblock.

The dataframe should have the following columns: {columns_to_extract}. No other columns.

The portion refers to the how the food item is portioned and typical values include:
- "snack"
- "whole"
- "Serving"
- "each"
- "6Z PORTION"
- "2 Links"
- "2 Pancakes"
- "Roll"
Note this column can also be blank so make sure to fill with "missing" if that happens

Note that the data will contain multiple columns containing the number of items served on each day of the 7 day period, as well as the week total. These will typically have a date as a column header, for example 01 NOV or 14 JUL. These are the orders on individual days and should be ignored. You should only focus on the "total" column, which is found on the far right of the form. If the week is a short one, they may have missing data.

Each visual row in the table represents exactly one item. Do NOT create multiple entries for a single item. Do NOT break down the data by date.

The data will also contain the date that it was recorded, in the top left of the page in the form "Date(s): 10/1/2024 To 10/7/2024", you should return the first date in the range in YYYY-MM-DD, in this case "2024-10-01". Every row will have the same date value.

Report the product name. Do not report the product code. if the product name contains preceding numbers in parenthesis, include them, for example "(2) burritos", note that sometimes product names are abbreviations.

The data may contain several rows of data with the same product name, this is fine and you should reproduce all days.

Sometimes quantities or sales may be numbers separated with commas, e.g. 1,245. you should reproduce the number without the commas, aka 1245.
