# CSV validation

`validate.ts` turns uploaded bytes into the CSV the analysis reads, or the reason we will not
accept them. The other files here each enforce one piece of that:

| File | Enforces |
| --- | --- |
| `decode.ts` | Encoding |
| `parse.ts` | Delimiter grammar |
| `columns.ts` | Header matching |
| `opening.ts` | Which delimiter and header the file resolves to |
| `dates.ts` | Date cells |
| `amounts.ts` | Amount cells |
| `products.ts` | Product cells, including the formula-injection check |
| `problems.ts` | Folding many failing rows into a few groups, without wording any of them |
| `describe.ts` | Every sentence a customer reading a rejection sees |

**Be more tolerant than the analysis, but never guess.** We accept things the analysis doesn't —
extra delimiters, extra encodings, the customer's other nineteen columns — and normalize them away
wherever that's safe, like dropping a column the analysis never reads. What we won't do is resolve
an ambiguity on the user's behalf: an ambiguous date or an unrecognized header gets rejected back to
them instead of guessed at.

What comes out is `product,date,weight`: comma-delimited, UTF-8, dates `YYYY-MM-DD`, amounts plain
numbers, and nothing else. Ambiguous dates, unit words, semicolon delimiters, Windows-1252 are rejected. Weights stay in the unit the form declared, which
the run manifest carries; converting them is the analysis's job.

**Banned APIs**, because each one would let the browser and the server disagree on a file the
other accepted — a disagreement the user cannot act on. Use `Date.UTC` only.

| API | Why not |
| --- | --- |
| `Intl`, `toLocale*` | Varies by runtime and by the user's machine |
| `Date.parse`, `new Date(string)` | Guesses at ambiguous input without saying so |
| `new Date(y, m, d)` | Depends on the local timezone |

Every file in this folder is imported by the browser as well as the server: keep them free of
`$env`, `$lib/server`, and anything Node-only.
