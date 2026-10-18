"""
Cache Sync
==========

Pulls the verified rows of the database's three caches into the CSV files the lab's loaders read,
so every loader, runscript and notebook reads the database's answers unchanged, and offline.

The database is `CACHE_DB_CONNECTION_STRING`'s, the variable a developer's worker reads too: as
`cache_client`, which can only read the caches and suggest rows to them. Never
`DB_CONNECTION_STRING`, which is `postgres`.

    python -m gbd_foodservice_insights_lab.cache_sync    # or `just pull-caches`
"""

import logging
import os
import tempfile
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pandas as pd
import psycopg
from dotenv import find_dotenv, load_dotenv
from psycopg import sql

from gbd_foodservice_insights_lab import clean_product_weights
from gbd_foodservice_insights_lab.categorization import entree_cache, product_cache

logger = logging.getLogger(__name__)

CONNECTION_STRING_VARIABLE: Final = "CACHE_DB_CONNECTION_STRING"
_SETUP_DOC: Final = "python/lab/README.md § Working on a client"


class CachePullError(RuntimeError):
    """The caches could not be pulled, for a reason whoever runs the lab must fix."""


@dataclass(frozen=True)
class CacheTable:
    table: str
    # Table column to CSV column, the key first.
    columns: Mapping[str, str]
    # Looked up through the loader's module at call time, so each path keeps its one definition.
    path: Callable[[], Path]

    @property
    def key(self) -> str:
        return next(iter(self.columns))


CACHE_TABLES: Final = (
    CacheTable(
        table="product_categorization",
        columns={
            "product": "product",
            "category": "category",
            "cleaned_name": "cleaned_item_names",
        },
        path=lambda: product_cache.categorization_cache_path(),
    ),
    CacheTable(
        table="entree_classification",
        columns={
            "product": "product",
            "classification": "entree_classification",
            "cleaned_name": "cleaned_item_names",
        },
        path=lambda: entree_cache.get_previously_classified_entrees_location(),
    ),
    CacheTable(
        table="unit_weight",
        columns={
            "original_unit": "original_unit",
            "cleaned_unit": "llm_cleaned_unit",
            "extracted_weight": "llm_extracted_weight",
            "example_products": "example_products",
        },
        path=lambda: clean_product_weights.get_previously_classified_weights_location(),
    ),
)


def connect() -> psycopg.Connection:
    """Open it per command, as `with connect() as connection:`. One kept in a notebook global is
    closed by the role's 10-minute idle-session timeout."""
    conninfo = os.environ.get(CONNECTION_STRING_VARIABLE)
    if not conninfo:
        raise CachePullError(f"{CONNECTION_STRING_VARIABLE} is not set; see {_SETUP_DOC}.")
    # Autocommit, so a connection never sits idle in a transaction, where it would block every
    # other insert of a key it inserted. `connect_timeout`, since libpq otherwise waits forever on
    # an unreachable host. The string's own `sslmode` and `sslrootcert` carry the TLS.
    return psycopg.connect(
        conninfo, autocommit=True, connect_timeout=10, application_name="lab-cache"
    )


def pull(connection: psycopg.Connection) -> None:
    """Overwrite each cache file with its table's verified rows, hand edits included."""
    info = connection.info
    logger.info(
        "Pulling the verified caches from %s@%s:%s/%s.",
        info.user,
        info.host,
        info.port,
        info.dbname,
    )
    # Every table is fetched before any file is written, so a failed query leaves every file as
    # it was.
    fetched = [(cache, _fetch_verified(connection, cache)) for cache in CACHE_TABLES]
    for cache, frame in fetched:
        path = cache.path()
        _replace_atomically(path, frame)
        logger.info("Pulled %d verified %s rows into %s.", len(frame), cache.table, path)


def pull_caches_if_configured() -> None:
    """Step 1's pull, before it calls any LLM."""
    if not os.environ.get(CONNECTION_STRING_VARIABLE):
        logger.warning(
            "%s is not set, so this run uses the cache files on disk as they are: %s. See %s.",
            CONNECTION_STRING_VARIABLE,
            "; ".join(_describe_age(cache.path()) for cache in CACHE_TABLES),
            _SETUP_DOC,
        )
        return

    # Stopping, rather than warning and running on the files on disk: a rotated password or a
    # typo would go unnoticed behind one line of a long log, while every run paid for LLM calls a
    # fresh cache would have answered.
    try:
        with connect() as connection:
            pull(connection)
    except psycopg.Error as error:
        raise CachePullError(
            f"Could not pull the caches from {CONNECTION_STRING_VARIABLE}; the error above says "
            f"why. To run on the cache files on disk instead, comment {CONNECTION_STRING_VARIABLE} "
            "out in .env."
        ) from error


def _fetch_verified(connection: psycopg.Connection, cache: CacheTable) -> pd.DataFrame:
    # Ordered so that a re-pull diffs cleanly against the last one.
    query = sql.SQL("SELECT {columns} FROM {table} WHERE is_verified ORDER BY {key}").format(
        columns=sql.SQL(", ").join(map(sql.Identifier, cache.columns)),
        table=sql.Identifier(cache.table),
        key=sql.Identifier(cache.key),
    )
    with connection.cursor() as cursor:
        rows = cursor.execute(query).fetchall()
    # No null mapping: `to_csv` writes a null empty, which every loader reads as missing.
    return pd.DataFrame(rows, columns=list(cache.columns.values()))


def _replace_atomically(path: Path, frame: pd.DataFrame) -> None:
    """Write beside `path`, then rename over it, so that neither a reader nor a concurrent pull
    ever sees half a file."""
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as file:
            frame.to_csv(file, index=False)
        temporary_path.replace(path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _describe_age(path: Path) -> str:
    try:
        modified = path.stat().st_mtime
    except FileNotFoundError:
        return f"{path.name} is missing"
    days = int((time.time() - modified) // 86_400)
    return f"{path.name} is {days} day{'' if days == 1 else 's'} old"


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s  %(name)s  %(levelname)s  %(message)s"
    )
    load_dotenv(find_dotenv(usecwd=True))
    with connect() as connection:
        pull(connection)


if __name__ == "__main__":
    main()
