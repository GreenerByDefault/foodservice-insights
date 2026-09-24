import json
from pathlib import Path
from typing import TypedDict, cast

import matplotlib.pyplot as plt
import pandas as pd
import pytest
from gbd_foodservice_insights.report.excel import (
    build_client_excel_report,
    build_qa_excel_report,
)
from gbd_foodservice_insights.report.pipeline import run_food_report


class _ExcelPayload(TypedDict):
    raw_df: pd.DataFrame
    monthly_product_data: pd.DataFrame
    monthly_category_data: pd.DataFrame
    template_data: pd.DataFrame
    highest_lowest: pd.DataFrame
    diner_meals_df: pd.DataFrame
    emissions_summary: pd.DataFrame
    animal_emissions_intensity: pd.DataFrame
    decision_kpis: pd.DataFrame
    substitution_scenarios: pd.DataFrame
    quality_findings_df: pd.DataFrame
    missingness_summary_df: pd.DataFrame
    data_profile_df: pd.DataFrame
    diagnostic_sheets: dict[str, pd.DataFrame]


def _sample_excel_payload() -> _ExcelPayload:
    template_data = pd.DataFrame({"Jan 2024": [12.0]}, index=pd.Index(["Legumes"], name="category"))
    return {
        "raw_df": pd.DataFrame({"product": ["Tofu"], "kilos_total": [12.0]}),
        "monthly_product_data": pd.DataFrame(
            {"month_year": ["2024-01"], "product": ["Tofu"], "kilos_total": [12.0]}
        ),
        "monthly_category_data": pd.DataFrame(
            {"month_year": ["2024-01"], "category": ["Legumes"], "kilos_total": [12.0]}
        ),
        "template_data": template_data,
        "highest_lowest": pd.DataFrame({"category": ["Legumes"], "times_higher": [1.2]}),
        "diner_meals_df": pd.DataFrame({"month_year": ["2024-01"], "Diners": [100]}),
        "emissions_summary": pd.DataFrame({"category": ["Legumes"], "total_kg_co2e": [3.4]}),
        "animal_emissions_intensity": pd.DataFrame(
            {
                "category": ["Beef and Buffalo Meat"],
                "kilos_total": [5.0],
                "total_kg_co2e": [206.75],
                "kg_co2e_per_kg_food": [41.35],
            }
        ),
        "decision_kpis": pd.DataFrame(
            {
                "KPI": ["Top 2 animal products share of animal-product emissions"],
                "Value": [91.2],
                "Unit": ["%"],
                "Denominator": ["Animal-product emissions only"],
                "Top products": ["beef mince, cheddar"],
                "Top product emissions (kg CO2e)": [342.5],
                "Total animal emissions (kg CO2e)": [375.5],
            }
        ),
        "substitution_scenarios": pd.DataFrame(
            {
                "scenario": [
                    "10% ruminant-to-legume swap",
                    "10% cow's-milk-to-oat-milk swap",
                ],
                "substitution_pct": [10.0, 10.0],
                "source_categories": [
                    "Beef and Buffalo Meat, Lamb/mutton & goat meat",
                    "Milk (Cow's milk)",
                ],
                "replacement_category": ["Legumes", "Oat Milk"],
                "baseline_ruminant_weight_kg": [20.0, 15.0],
                "baseline_ruminant_emissions_kg_co2e": [829.95, 49.2],
                "replaced_weight_kg": [2.0, 1.5],
                "remaining_ruminant_weight_kg": [18.0, 13.5],
                "replacement_weight_kg": [2.0, 1.5],
                "replacement_emission_factor_kg_co2e_per_kg": [1.6, 1.2],
                "projected_emissions_kg_co2e": [748.3, 44.64],
                "avoidable_kg_co2e": [81.65, 4.56],
                "institution_emissions_avoided_pct": [9.82, 0.55],
            }
        ),
        "quality_findings_df": pd.DataFrame(
            {"status": ["warning"], "message": ["Example quality finding"]}
        ),
        "missingness_summary_df": pd.DataFrame({"column": ["date"], "missing_count": [0]}),
        "data_profile_df": pd.DataFrame({"column": ["kilos_total"], "mean": [12.0]}),
        "diagnostic_sheets": {
            "Denominator_QC": pd.DataFrame({"month_year": ["2024-01"], "is_flagged": [False]}),
        },
    }


@pytest.fixture
def food_report_tmp_data(tmp_path: Path):
    input_df = pd.DataFrame(
        {
            "date": ["2024-01-05", "2024-02-05"],
            "product": ["tofu", "beef"],
            "category": ["legumes", "beef and buffalo meat"],
            "kilos_total": [10.0, 5.0],
        }
    )

    input_path = tmp_path / "categorized_test.csv"
    input_df.to_csv(input_path, index=False)

    diner_path = tmp_path / "diner_meals.json"
    diner_path.write_text(json.dumps({"2024-01": 1000, "2024-02": 1100}))

    metadata_path = tmp_path / "client_metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "client": "Test Client",
                "baseline_pilot": "baseline",
                "procurement_serving": "procurement",
                "pdf_extracted": False,
            }
        )
    )

    return input_path, diner_path, metadata_path


def test_build_client_excel_report_excludes_internal_tabs(tmp_path: Path):
    payload = _sample_excel_payload()
    output_path = build_client_excel_report(
        output_path=str(tmp_path / "client.xlsx"),
        monthly_product_data=payload["monthly_product_data"],
        monthly_category_data=payload["monthly_category_data"],
        template_data=payload["template_data"],
        highest_lowest=payload["highest_lowest"],
        diner_meals_df=payload["diner_meals_df"],
        emissions_summary=payload["emissions_summary"],
        animal_emissions_intensity=payload["animal_emissions_intensity"],
        decision_kpis=payload["decision_kpis"],
        substitution_scenarios=payload["substitution_scenarios"],
    )

    sheet_names = pd.ExcelFile(output_path).sheet_names

    assert "Monthly by Product" in sheet_names
    assert "Monthly by Category" in sheet_names
    assert "Template" in sheet_names
    assert "Category Stability" not in sheet_names
    assert "Diners" in sheet_names
    assert "Emissions Summary" in sheet_names
    assert "Animal Emissions Intensity" in sheet_names
    assert "Decision_KPIs" in sheet_names
    assert "Substitution_Scenarios" in sheet_names
    assert "Raw Data" not in sheet_names
    assert "Data_Quality_Findings" not in sheet_names
    assert "Missingness_Summary" not in sheet_names
    assert "Data Profile" not in sheet_names
    assert "Denominator_QC" not in sheet_names


def test_build_qa_excel_report_includes_debug_tabs(tmp_path: Path):
    payload = _sample_excel_payload()
    output_path = build_qa_excel_report(
        output_path=str(tmp_path / "qa.xlsx"),
        raw_df=payload["raw_df"],
        monthly_product_data=payload["monthly_product_data"],
        monthly_category_data=payload["monthly_category_data"],
        template_data=payload["template_data"],
        highest_lowest=payload["highest_lowest"],
        diner_meals_df=payload["diner_meals_df"],
        emissions_summary=payload["emissions_summary"],
        animal_emissions_intensity=payload["animal_emissions_intensity"],
        decision_kpis=payload["decision_kpis"],
        substitution_scenarios=payload["substitution_scenarios"],
        quality_findings_df=payload["quality_findings_df"],
        missingness_summary_df=payload["missingness_summary_df"],
        data_profile_df=payload["data_profile_df"],
        diagnostic_sheets=payload["diagnostic_sheets"],
    )

    sheet_names = pd.ExcelFile(output_path).sheet_names

    assert "Monthly by Product" in sheet_names
    assert "Monthly by Category" in sheet_names
    assert "Template" in sheet_names
    assert "Category Stability" in sheet_names
    assert "Diners" in sheet_names
    assert "Emissions Summary" in sheet_names
    assert "Animal Emissions Intensity" in sheet_names
    assert "Decision_KPIs" in sheet_names
    assert "Substitution_Scenarios" in sheet_names
    assert "Raw Data" in sheet_names
    assert "Data_Quality_Findings" in sheet_names
    assert "Missingness_Summary" in sheet_names
    assert "Data Profile" in sheet_names
    assert "Denominator_QC" in sheet_names


def test_run_food_report_creates_multi_artifact_outputs_and_updates_metadata(
    monkeypatch, food_report_tmp_data, tmp_path: Path
):
    input_path, diner_path, metadata_path = food_report_tmp_data
    captured_pdf_kwargs: dict[str, object] = {}

    def fake_build_pdf_report(output_path: str, **kwargs: object) -> str:
        captured_pdf_kwargs.update(kwargs)
        path = Path(output_path)
        path.write_text("placeholder pdf")
        return str(path)

    fig, ax = plt.subplots()
    ax.set_title("Test Export Plot")

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        fake_build_pdf_report,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.plots.generate_all_report_plots",
        lambda **kwargs: [("", fig)],
    )

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    assert result["run_status"] == "success"
    assert result["excel_path"] == result["client_excel_path"]
    assert Path(result["pdf_path"]).exists()
    assert Path(result["client_excel_path"]).exists()
    assert Path(result["qa_excel_path"]).exists()
    assert Path(result["manifest_path"]).exists()
    assert Path(result["log_path"]).exists()
    assert Path(result["graphs_dir"]).exists()
    assert len(result["graph_paths"]) == 1
    assert Path(result["graph_paths"][0]).exists()
    assert Path(result["graph_paths"][0]).parent == Path(result["graphs_dir"])

    client_sheet_names = pd.ExcelFile(result["client_excel_path"]).sheet_names
    qa_sheet_names = pd.ExcelFile(result["qa_excel_path"]).sheet_names

    assert "Raw Data" not in client_sheet_names
    assert "Data_Quality_Findings" not in client_sheet_names
    assert "Animal Emissions Intensity" in client_sheet_names
    assert "Decision_KPIs" in client_sheet_names
    assert "Substitution_Scenarios" in client_sheet_names
    assert "Category Stability" not in client_sheet_names
    assert "Raw Data" in qa_sheet_names
    assert "Data_Quality_Findings" in qa_sheet_names
    assert "Animal Emissions Intensity" in qa_sheet_names
    assert "Decision_KPIs" in qa_sheet_names
    assert "Substitution_Scenarios" in qa_sheet_names
    assert "Category Stability" in qa_sheet_names
    assert "Denominator_QC" in qa_sheet_names
    summary_stats_value = captured_pdf_kwargs["summary_stats"]
    tables_value = captured_pdf_kwargs["tables"]
    assert isinstance(summary_stats_value, dict)
    assert isinstance(tables_value, dict)
    summary_stats = cast(dict[str, str], summary_stats_value)
    tables = cast(dict[str, pd.DataFrame], tables_value)

    assert "Plant protein share (% of protein categories)" in summary_stats
    assert "Plant-based total" in summary_stats
    assert summary_stats["Plant-based total"].endswith(" kg")
    assert "Animal-based total" in summary_stats
    assert summary_stats["Animal-based total"].endswith(" kg")
    assert "Plant protein total" in summary_stats
    assert summary_stats["Plant protein total"].endswith(" kg")
    assert "Protein-category total" in summary_stats
    assert summary_stats["Protein-category total"].endswith(" kg")
    assert summary_stats["Region used for climate emissions factors"] == "US/Canada"
    assert "Animal Emissions Intensity" in tables
    assert "Decision KPIs" in tables
    assert "Substitution Scenarios" in tables
    animal_pdf_table = tables["Animal Emissions Intensity"]
    assert animal_pdf_table.columns.tolist() == [
        "Category",
        "Kilos of Food",
        "CO2e Per Kg Food",
        "Kg CO2e Kg",
    ]
    assert animal_pdf_table["Kilos of Food"].tolist() == [5]
    assert animal_pdf_table["Kg CO2e Kg"].dtype.name == "Int64"
    assert animal_pdf_table["Kg CO2e Kg"].iloc[0] == round(
        float(animal_pdf_table["Kg CO2e Kg"].iloc[0])
    )
    assert animal_pdf_table["CO2e Per Kg Food"].iloc[0] == round(
        float(animal_pdf_table["CO2e Per Kg Food"].iloc[0]), 2
    )
    decision_kpi_pdf_table = tables["Decision KPIs"]
    assert decision_kpi_pdf_table.columns.tolist() == [
        "Focus",
        "Share of Animal Emissions (%)",
        "Top Animal Products",
        "Top Products Kg CO2e",
        "Total Animal Kg CO2e",
    ]
    substitution_pdf_table = tables["Substitution Scenarios"]
    assert substitution_pdf_table.columns.tolist() == [
        "Scenario",
        "Weight Replaced (kg)",
        "Projected Kg CO2e",
        "Avoidable Kg CO2e",
        "Institution Emissions Averted (%)",
    ]
    assert substitution_pdf_table["Weight Replaced (kg)"].dtype.name == "Int64"
    assert substitution_pdf_table["Projected Kg CO2e"].dtype.name == "Int64"
    assert substitution_pdf_table["Avoidable Kg CO2e"].dtype.name == "Int64"
    assert all(
        float(value).is_integer()
        for value in substitution_pdf_table["Weight Replaced (kg)"].dropna()
    )
    assert all(
        float(value).is_integer() for value in substitution_pdf_table["Projected Kg CO2e"].dropna()
    )
    assert all(
        float(value).is_integer() for value in substitution_pdf_table["Avoidable Kg CO2e"].dropna()
    )
    assert "Category Stability (Highest / Lowest Months)" not in tables

    manifest = json.loads(Path(result["manifest_path"]).read_text())
    assert manifest["run_status"] == "success"
    assert manifest["run_id"] == result["run_id"]
    assert manifest["outputs"]["client_excel"] == result["client_excel_path"]
    assert manifest["outputs"]["qa_excel"] == result["qa_excel_path"]
    assert manifest["outputs"]["log"] == result["log_path"]
    assert manifest["outputs"]["graphs_dir"] == result["graphs_dir"]
    assert manifest["outputs"]["graphs"] == result["graph_paths"]

    metadata = json.loads(metadata_path.read_text())
    assert metadata["food_report_excel"] == result["client_excel_path"]
    assert metadata["food_report_client_excel"] == result["client_excel_path"]
    assert metadata["food_report_qa_excel"] == result["qa_excel_path"]
    assert metadata["food_report_manifest"] == result["manifest_path"]
    assert metadata["food_report_log"] == result["log_path"]
    assert metadata["food_report_graphs_dir"] == result["graphs_dir"]
    assert metadata["food_report_graph_count"] == len(result["graph_paths"])

    plt.close(fig)


def test_run_food_report_uses_europe_friendly_region_summary_label(
    monkeypatch, food_report_tmp_data, tmp_path: Path
):
    input_path, diner_path, _metadata_path = food_report_tmp_data
    captured_pdf_kwargs: dict[str, object] = {}

    def fake_build_pdf_report(output_path: str, **kwargs: object) -> str:
        captured_pdf_kwargs.update(kwargs)
        path = Path(output_path)
        path.write_text("placeholder pdf")
        return str(path)

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        fake_build_pdf_report,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.plots.generate_all_report_plots",
        lambda **kwargs: [],
    )

    run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        region="europe",
        missing_data_policy="warn_continue",
    )

    summary_stats_value = captured_pdf_kwargs["summary_stats"]
    assert isinstance(summary_stats_value, dict)
    summary_stats = cast(dict[str, str], summary_stats_value)
    assert summary_stats["Region used for climate emissions factors"] == "EU/UK"


def test_run_food_report_defaults_outputs_to_named_subdirectory(monkeypatch, food_report_tmp_data):
    input_path, diner_path, _ = food_report_tmp_data

    def fake_build_pdf_report(output_path: str, **_: object) -> str:
        path = Path(output_path)
        path.write_text("placeholder pdf")
        return str(path)

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        fake_build_pdf_report,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.plots.generate_all_report_plots",
        lambda **kwargs: [],
    )

    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    expected_output_dir = (
        Path(input_path).parent / "outputs" / Path(input_path).stem.replace("categorized_", "")
    )
    assert Path(result["pdf_path"]).parent == expected_output_dir
    assert Path(result["client_excel_path"]).parent == expected_output_dir
    assert Path(result["qa_excel_path"]).parent == expected_output_dir
    assert Path(result["manifest_path"]).parent == expected_output_dir
    assert Path(result["log_path"]).parent == expected_output_dir
    assert Path(result["graphs_dir"]).parent == expected_output_dir


def test_run_food_report_writes_failure_manifest_and_log(
    monkeypatch, food_report_tmp_data, tmp_path: Path
):
    """A failed run after logging starts should still leave a manifest and log trail."""
    input_path, diner_path, _ = food_report_tmp_data

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.plots.generate_all_report_plots",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("plot boom")),
    )

    with pytest.raises(RuntimeError, match="plot boom"):
        run_food_report(
            input_file=input_path,
            diner_meal_file=diner_path,
            output_dir=tmp_path,
            procurement_serving="procurement",
            missing_data_policy="warn_continue",
        )

    manifest_path = tmp_path / "food_report_test_manifest.json"
    log_path = tmp_path / "food_report_test.log"

    assert manifest_path.exists()
    assert log_path.exists()

    manifest = json.loads(manifest_path.read_text())
    assert manifest["run_status"] == "failed"
    assert manifest["error_message"] == "plot boom"

    log_text = log_path.read_text()
    assert "Step: Building the report charts." in log_text
    assert "plot boom" in log_text


def test_run_food_report_does_not_duplicate_log_lines_across_repeated_runs(
    monkeypatch, food_report_tmp_data, tmp_path: Path
):
    """Per-run handlers should be removed so later runs do not write duplicate lines."""
    input_path, diner_path, _ = food_report_tmp_data

    def fake_build_pdf_report(output_path: str, **_: object) -> str:
        path = Path(output_path)
        path.write_text("placeholder pdf")
        return str(path)

    monkeypatch.setattr(
        "gbd_foodservice_insights.report.pdf.build_pdf_report",
        fake_build_pdf_report,
    )
    monkeypatch.setattr(
        "gbd_foodservice_insights.report.plots.generate_all_report_plots",
        lambda **kwargs: [],
    )

    run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )
    result = run_food_report(
        input_file=input_path,
        diner_meal_file=diner_path,
        output_dir=tmp_path,
        procurement_serving="procurement",
        missing_data_policy="warn_continue",
    )

    log_text = Path(result["log_path"]).read_text()
    assert log_text.count("Step: Loading the input data.") == 1
    assert log_text.count("Closing the report run log.") == 1
