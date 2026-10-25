# Lab test data

A small anonymized sample of one institutional caterer's procurement, for trying a lab change
without client data. Product names were altered while keeping their food category, dates shifted
back a year, and amounts given random noise, so the files are safe to commit. They are not for
client work or any real analysis.

Each directory holds the input to a step of the [lab pipeline](../README.md#the-pipeline):

| File | Input to |
| --- | --- |
| `raw_data/sample_raw_purchasing.csv` | Step 0.5. A messy export, with junk header rows above the real one |
| `step_1b_output/extracted_data.csv` | Step 0.5's cleaning. Extracted, with missing dates and a negative amount left to catch |
| `step_2_output/validated_data.csv` | Step 1. Clean and ready to categorize |
| `step_3_output/categorized_data.csv` | Step 2. Categorized |

The directory names come from an older numbering of the pipeline.
