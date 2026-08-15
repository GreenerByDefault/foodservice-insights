# CSV validation

Turning an uploaded file into the CSV the analysis reads — or the reason we will not accept
it — splits across the files here, each enforcing one piece of that:

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

Every file above `problems.ts` in the table is data and rules, never words: `describe.ts` is
the only one that turns a `DecodeProblem`, an `OpeningProblem`, a `HeaderProblem`, or a
`RowProblem`/`FileProblem` from `problems.ts` into a sentence. `grep -n "[A-Z][a-z]* .*\." *.ts`
finding prose only in `describe.ts` is the invariant that keeps that true.

**Accept only what we can normalize without guessing.** We may be more permissive than the
analysis about a file's *format* — delimiters, encodings, the ways a date can be written — and we
are stricter about what a value *means*. Because what we accept stays a subset of what the
analysis accepts, the two drifting apart can only ever cause a visible false rejection, never a
wrong report. That is also why the alias set in `columns.ts` is tiny: a header we do not recognise
is something the user can fix, while a header we recognise wrongly — `qty` read as a weight — is a
confident wrong answer nobody downstream can catch.

What comes out is `product,date,weight`: comma-delimited, UTF-8, dates `YYYY-MM-DD`, amounts plain
numbers, and nothing else. Ambiguous dates, unit words, semicolon delimiters, Windows-1252 and the
customer's other nineteen columns all stop here. Weights stay in the unit the form declared, which
the run manifest carries; converting them is the analysis's job.

**No `Intl`, no `toLocale*`, no `Date.parse`, no `new Date(string)` or `new Date(y, m, d)`.**
`Intl` and `toLocale*` vary by runtime and by the user's machine; the `Date` forms either guess at
ambiguous input without saying so or depend on the local timezone. `Date.UTC` only. The browser
runs the same checks as the server for instant feedback, so any of these would make the two
disagree — a disagreement the user cannot act on.

Every file in this folder is imported by the browser as well as the server: keep them free of
`$env`, `$lib/server`, and anything Node-only.
