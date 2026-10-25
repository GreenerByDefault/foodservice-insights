import contextlib
import logging
import os
import time
import uuid
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pandas as pd
import psycopg
import pytest
from gbd_foodservice_insights_lab import cache_sync
from gbd_foodservice_insights_lab.categorization import entree_cache, product_cache
from gbd_foodservice_insights_lab.categorization.entree_cache import (
    get_previously_classified_entrees,
)
from gbd_foodservice_insights_lab.categorization.product_cache import load_categorization_cache
from psycopg import sql

VARIABLE = cache_sync.CONNECTION_STRING_VARIABLE


@pytest.fixture
def cache_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, Path]:
    """Points the two loaders, and so `pull`, at `tmp_path` instead of the real files."""
    products = tmp_path / "previously_categorized_items.csv"
    entrees = tmp_path / "previously_classified_entrees.csv"
    monkeypatch.setattr(product_cache, "categorization_cache_path", lambda: products)
    monkeypatch.setattr(entree_cache, "get_previously_classified_entrees_location", lambda: entrees)
    return products, entrees


def _insert(
    connection: psycopg.Connection,
    table: str,
    columns: Sequence[str],
    rows: Sequence[tuple[Any, ...]],
) -> None:
    query = sql.SQL("INSERT INTO {table} ({columns}) VALUES ({values})").format(
        table=sql.Identifier(table),
        columns=sql.SQL(", ").join(map(sql.Identifier, columns)),
        values=sql.SQL(", ").join(sql.Placeholder() * len(columns)),
    )
    with connection.cursor() as cursor:
        cursor.executemany(query, rows)


def _rows_containing(frame: pd.DataFrame, key: str, prefix: str) -> list[dict[str, Any]]:
    """This test's rows, since the test database is shared, sorted, with a missing value as None."""
    mine = frame.loc[frame[key].str.contains(prefix, regex=False)].sort_values(key)
    return mine.astype(object).where(mine.notna(), None).to_dict("records")


def _fake_connection() -> Any:
    return SimpleNamespace(
        info=SimpleNamespace(user="cache_client", host="db.example", port=5432, dbname="postgres")
    )


def test_pull_writes_the_verified_rows_for_the_loaders_to_read(
    test_database: psycopg.Connection, cache_files: tuple[Path, Path]
) -> None:
    prefix = f"pull-{uuid.uuid4()}"
    awkward = f'{prefix} Bacon, "thick"\ncut'
    _insert(
        test_database,
        "product_categorization",
        ("product", "category", "cleaned_name", "is_verified"),
        [
            (awkward, "Pork (pig meat)", "bacon", True),
            (f"{prefix} yogurt", "Yogurt", None, True),
            (f"{prefix} unverified", "Yogurt", "yogurt", False),
        ],
    )
    _insert(
        test_database,
        "entree_classification",
        ("product", "classification", "cleaned_name", "is_verified"),
        [
            (awkward, "side/add-on", "bacon", True),
            (f"{prefix} taco", "entree", None, True),
            (f"{prefix} unverified", "entree", "taco", False),
        ],
    )
    test_database.execute("SET LOCAL ROLE cache_client")

    cache_sync.pull(test_database)

    assert _rows_containing(load_categorization_cache().products, "product", prefix) == [
        {"product": awkward, "category": "Pork (pig meat)", "cleaned_item_names": "bacon"},
        {"product": f"{prefix} yogurt", "category": "Yogurt", "cleaned_item_names": ""},
    ]
    assert _rows_containing(get_previously_classified_entrees(), "product", prefix) == [
        {"product": awkward, "entree_classification": "side/add-on", "cleaned_item_names": "bacon"},
        {
            "product": f"{prefix} taco",
            "entree_classification": "entree",
            "cleaned_item_names": None,
        },
    ]


def test_pull_writes_no_file_when_a_query_fails(
    monkeypatch: pytest.MonkeyPatch, cache_files: tuple[Path, Path]
) -> None:
    for path in cache_files:
        path.write_text("as it was\n")

    def _fetch_verified(_connection: object, cache: cache_sync.CacheTable) -> pd.DataFrame:
        if cache.table == "entree_classification":
            raise psycopg.errors.InsufficientPrivilege(
                "permission denied for table entree_classification"
            )
        return pd.DataFrame(columns=list(cache.columns.values()))

    monkeypatch.setattr(cache_sync, "_fetch_verified", _fetch_verified)

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        cache_sync.pull(_fake_connection())

    assert [path.read_text() for path in cache_files] == ["as it was\n"] * 2


def test_pull_of_no_verified_rows_leaves_files_the_loaders_read_as_empty(
    monkeypatch: pytest.MonkeyPatch, cache_files: tuple[Path, Path]
) -> None:
    for path in cache_files:
        path.write_text("stale\n")
    monkeypatch.setattr(
        cache_sync,
        "_fetch_verified",
        lambda _connection, cache: pd.DataFrame(columns=list(cache.columns.values())),
    )

    cache_sync.pull(_fake_connection())

    assert load_categorization_cache().products.empty
    entrees = get_previously_classified_entrees()
    assert (entrees.empty, list(entrees.columns)) == (
        True,
        ["product", "entree_classification", "cleaned_item_names"],
    )


def test_pull_that_fails_mid_write_keeps_the_file_and_leaves_no_temporary(
    monkeypatch: pytest.MonkeyPatch, cache_files: tuple[Path, Path]
) -> None:
    products, _ = cache_files
    products.write_text("as it was\n")

    class _DiskFull:
        def to_csv(self, file: Any, **_: Any) -> None:
            file.write("half a")
            raise OSError(28, "No space left on device")

    monkeypatch.setattr(cache_sync, "_fetch_verified", lambda _connection, _cache: _DiskFull())

    with pytest.raises(OSError, match="No space left on device"):
        cache_sync.pull(_fake_connection())

    assert sorted(path.name for path in products.parent.iterdir()) == [products.name]
    assert products.read_text() == "as it was\n"


@pytest.mark.parametrize("unset", [None, ""], ids=["absent", "empty"])
def test_unset_warns_with_each_files_age(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    cache_files: tuple[Path, Path],
    unset: str | None,
) -> None:
    if unset is None:
        monkeypatch.delenv(VARIABLE, raising=False)
    else:
        monkeypatch.setenv(VARIABLE, unset)
    products, entrees = cache_files
    for path, days in ((products, 3), (entrees, 1)):
        path.write_text("header\n")
        modified = time.time() - days * 86_400 - 60
        os.utime(path, (modified, modified))
    caplog.set_level(logging.WARNING, logger=cache_sync.__name__)

    cache_sync.pull_caches_if_configured()

    assert caplog.record_tuples == [
        (
            cache_sync.__name__,
            logging.WARNING,
            "CACHE_DB_CONNECTION_STRING is not set, so this run uses the cache files on disk as "
            "they are: previously_categorized_items.csv is 3 days old; "
            "previously_classified_entrees.csv is 1 day old. "
            "See python/lab/README.md § Working on a client.",
        )
    ]


def test_set_but_unreachable_stops_naming_the_variable(
    monkeypatch: pytest.MonkeyPatch, cache_files: tuple[Path, Path]
) -> None:
    monkeypatch.setenv(VARIABLE, "postgresql://nobody@127.0.0.1:1/x")

    with pytest.raises(cache_sync.CachePullError) as raised:
        cache_sync.pull_caches_if_configured()

    assert str(raised.value) == (
        "Could not pull the caches from CACHE_DB_CONNECTION_STRING; the error above says why. To "
        "run on the cache files on disk instead, comment CACHE_DB_CONNECTION_STRING out in .env."
    )
    assert isinstance(raised.value.__cause__, psycopg.OperationalError)


def test_set_pulls_over_a_new_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(VARIABLE, "postgresql://cache_client@db.example/postgres")
    connection = object()
    monkeypatch.setattr(cache_sync, "connect", lambda: contextlib.nullcontext(connection))
    pulled: list[object] = []
    monkeypatch.setattr(cache_sync, "pull", pulled.append)

    cache_sync.pull_caches_if_configured()

    assert pulled == [connection]


@pytest.mark.parametrize(
    "conninfo",
    [
        "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres",
        "postgresql://postgres@localhost/postgres?hostaddr=203.0.113.1",
        "host=db.abcdefghijklmnop.supabase.co user=cache_client_admin",
    ],
)
def test_connect_refuses_a_hosted_database_as_anyone_but_cache_client(
    monkeypatch: pytest.MonkeyPatch, conninfo: str
) -> None:
    monkeypatch.setenv(VARIABLE, conninfo)
    monkeypatch.setattr(psycopg, "connect", _never_connects)

    with pytest.raises(cache_sync.CachePullError, match="AI agents: stop and ask a human"):
        cache_sync.connect()


@pytest.mark.parametrize(
    "conninfo",
    [
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "postgresql://cache_client:secret@db.abcdefghijklmnop.supabase.co:5432/postgres",
        "postgresql://cache_client.abcdefghijklmnop:secret@aws-0-us-east-1.pooler.supabase.com/postgres",
    ],
)
def test_connect_accepts_a_local_stack_or_cache_client(
    monkeypatch: pytest.MonkeyPatch, conninfo: str
) -> None:
    monkeypatch.setenv(VARIABLE, conninfo)
    connected: list[str] = []
    monkeypatch.setattr(psycopg, "connect", lambda conninfo, **_: connected.append(conninfo))

    cache_sync.connect()

    assert connected == [conninfo]


def _never_connects(*_: object, **__: object) -> None:
    raise AssertionError("connect() reached psycopg.connect")


def test_connect_names_the_variable_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(VARIABLE, raising=False)

    with pytest.raises(cache_sync.CachePullError, match="CACHE_DB_CONNECTION_STRING is not set"):
        cache_sync.connect()
