# PDF Table Extraction Task

You are an expert data analyst. The following text was extracted from a single page of a PDF document.

## Your Task

Identify the main table, clean it, and reformat it as a Markdown table.

## What to Expect

- Table data, possibly with multi-line rows or messy formatting
- Headers may be unclear or split across multiple lines
- Values may be misaligned due to PDF extraction artifacts

## What to Ignore

- Page headers, footers, and watermarks
- Any text that is not part of the main data table
- Advertisements or decorative elements

## Output Requirements

- **If a table is found:** Output ONLY a clean Markdown table of the data
- **If no table is found:** Output exactly: "No table found on this page."
- Do NOT return in a code block
- Do NOT explain your output
- Just return the raw text in markdown format

## Example Output

**Example 1 - Table Found:**
```
| Product Name | Quantity | Unit | Price |
|--------------|----------|------|-------|
| Apples | 50 | lbs | $2.50 |
| Carrots | 25 | lbs | $1.75 |
```

**Example 2 - No Table:**
```
No table found on this page.
```
