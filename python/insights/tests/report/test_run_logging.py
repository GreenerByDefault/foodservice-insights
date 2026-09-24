from gbd_foodservice_insights.categorization import cache, entrees, steps
from gbd_foodservice_insights.report import run_logging


class TestAttachReportRunFileHandler:
    """Tests for attach_report_run_file_handler."""

    def test_module_loggers_propagate_into_the_run_log(self, tmp_path):
        log_path = tmp_path / "run.log"
        handler_state = run_logging.attach_report_run_file_handler(log_path)
        try:
            steps.logger.info("categorize_steps emitted this line")
        finally:
            run_logging.close_report_run_file_handler(handler_state)

        assert "categorize_steps emitted this line" in log_path.read_text()


def test_categorize_cache_and_categorize_entrees_get_their_own_logger_name():
    names = {
        cache.logger.name,
        entrees.logger.name,
        steps.logger.name,
    }
    assert names == {
        "gbd_foodservice_insights.categorization.cache",
        "gbd_foodservice_insights.categorization.entrees",
        "gbd_foodservice_insights.categorization.steps",
    }
