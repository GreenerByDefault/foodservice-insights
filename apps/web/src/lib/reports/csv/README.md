# CSV validation

`validate.ts` turns uploaded bytes into the CSV the analysis reads, or the reason we will not
accept them. The folder is three layers, one word each for what they hand upward:

| Word | Means | Lives in |
| --- | --- | --- |
| **Fault** | What is wrong with one thing — a byte stream, a header, a cell | `read/`, `rules/` |
| **Finding** | A fault, plus the rows it was found on | `findings.ts` |
| **Problem** | What the customer reads about a finding | `describe/` |

A value has a *fault*; we record a *finding*; we show a *problem*. Every sentence about the
user's file lives in `describe/`. `read/` and `rules/` return fault codes.

`validate.ts` and `findings.ts` stay at the top of `csv/` because they *are* the pipeline;
`read/`, `rules/`, and `describe/` hold the leaf modules underneath it. `findings.ts` folds many
failing rows into a few groups.

### `read/` — bytes into a table, or a fault code

| File | Enforces |
| --- | --- |
| `decode.ts` | Encoding |
| `parse.ts` | Delimiter grammar |
| `columns.ts` | Header matching |
| `layout.ts` | Which delimiter and header the file resolves to |

### `rules/` — one value into ok, or its fault code

| File | Enforces |
| --- | --- |
| `calendar.ts` | Calendar fields into an ISO date inside the accepted range |
| `dates.ts` | Date cells |
| `date-order.ts` | Deciding a column's day-first/month-first order |
| `amounts.ts` | Amount cells |
| `products.ts` | Product cells, including the formula-injection check |

### `describe/` — every sentence a customer reading a rejection sees

One module per thing being described, mirroring what produces it:

| File | Describes |
| --- | --- |
| `file.ts` | A file refused before a row was read — the decode / layout / header / parse-error rejections |
| `rows.ts` | One row problem: the fault code's clause and advice, the rows it covers, the quoted examples |
| `date-order.ts` | A column-wide date-order failure, which is prose rather than a row problem |
| `findings.ts` | The assembly: budgeting row problems against the date-order problem into a summary, reason, and detail |
| `problems.ts` | The `Problem` payload, and rendering it back to `rejectionDetail` text |
| `text.ts` | Shared prose helpers: quoting, joining, pluralizing, formatting numbers |

**Be more tolerant than the analysis, but never guess.** We accept things the analysis doesn't —
extra delimiters, extra encodings, the customer's other nineteen columns — and normalize them away
wherever that's safe, like dropping a column the analysis never reads. What we won't do is resolve
an ambiguity on the user's behalf: an ambiguous date or an unrecognized header gets rejected back to
them instead of guessed at.

What comes out is `product,date,weight`: comma-delimited, UTF-8, dates `YYYY-MM-DD`, amounts plain
numbers, and nothing else. Ambiguous dates, unit words, semicolon delimiters, Windows-1252 are rejected. Weights stay in the unit the form declared, which
the run manifest carries; converting them is the analysis's job.

Every file in this folder is imported by the browser as well as the server: keep them free of
`$env`, `$lib/server`, and anything Node-only.
