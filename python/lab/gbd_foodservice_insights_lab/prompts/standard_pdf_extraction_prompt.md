This is data I have extracted from catering data. It details the {columns_to_extract}.
Please reformat this text into a markdown table I can later read into python as a dataframe.
The data contains data from a specific date, indicated by "period from". Add this to the markdown table as a "date" column. It should follow the format YYYY-MM-DD.
Only output a markdown table of the data and nothing else. Do not explain the output, just return it.
Use no other heading except {columns_to_extract} and date.
DO NOT return in a codeblock.
Just return the raw text in markdown format.
Report the product name. Do not report the product code. if the product name contains preceding numbers in parenthesis, include them, for example "(2) burritos", note that sometimes product names are abbreviations.
The data contains multiple days of data, where each day has similar products. reproduce all days.
Sometimes quantities or sales may be numbers separated with commas, e.g. 1,245. you should reproduce the number without the commas, aka 1245.
