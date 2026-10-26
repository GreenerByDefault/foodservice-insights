import contextlib
import logging
import os
import re
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn

import numpy as np
import pandas as pd
import psycopg
import pytest
from gbd_foodservice_insights.categorization.cache import normalize_product_name
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
    awkward = f'{prefix} Bacon, "thick" cut'
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
        ("product", "classification", "is_verified"),
        [
            (awkward, "side/add-on", True),
            (f"{prefix} taco", "entree", True),
            (f"{prefix} unverified", "entree", False),
        ],
    )
    test_database.execute("SET LOCAL ROLE cache_client")

    cache_sync.pull(test_database)

    assert _rows_containing(load_categorization_cache().products, "product", prefix) == [
        {"product": awkward, "category": "Pork (pig meat)", "cleaned_item_names": "bacon"},
        {"product": f"{prefix} yogurt", "category": "Yogurt", "cleaned_item_names": ""},
    ]
    assert _rows_containing(get_previously_classified_entrees(), "product", prefix) == [
        {"product": awkward, "entree_classification": "side/add-on"},
        {"product": f"{prefix} taco", "entree_classification": "entree"},
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
    assert (entrees.empty, list(entrees.columns)) == (True, ["product", "entree_classification"])


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

    with pytest.raises(cache_sync.CacheSyncError) as raised:
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

    with pytest.raises(cache_sync.CacheSyncError, match="AI agents: stop and ask a human"):
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

    with pytest.raises(cache_sync.CacheSyncError, match="CACHE_DB_CONNECTION_STRING is not set"):
        cache_sync.connect()


# ----------------------------------------------------------------------
# Push
# ----------------------------------------------------------------------

SUGGESTED_BY = "lab:tester"
KEY_AT_MAX_BYTES = "🥕" * (cache_sync.MAX_CACHE_KEY_BYTES // 4)


class _RecordingConnection:
    """Records what a push sends, as rows of the table's columns plus `suggested_by`."""

    def __init__(self) -> None:
        self.sent: list[tuple[Any, ...]] = []
        self.rowcount = 0

    def transaction(self) -> contextlib.AbstractContextManager[None]:
        return contextlib.nullcontext()

    def cursor(self) -> contextlib.AbstractContextManager[Any]:
        return contextlib.nullcontext(self)

    def executemany(self, _query: object, rows: Any) -> None:
        self.sent = list(rows)
        self.rowcount = len(self.sent)


def _frame(defaults: dict[str, Any], columns: dict[str, list[Any]]) -> pd.DataFrame:
    """`defaults` repeated to the length of `columns`, which override them."""
    rows = max(map(len, columns.values()), default=1)
    return pd.DataFrame({name: [value] * rows for name, value in defaults.items()} | columns)


def _products(**columns: list[Any]) -> pd.DataFrame:
    return _frame(
        {"product": "Bacon", "category": "Pork (pig meat)", "cleaned_item_names": "bacon"},
        columns,
    )


def _entrees(**columns: list[Any]) -> pd.DataFrame:
    return _frame(
        {"product": "Taco", "entree_classification": "entree"},
        columns,
    )


def test_push_product_categorizations_sends_rows_the_checks_accept() -> None:
    connection: Any = _RecordingConnection()
    frame = _products(
        product=[" Bacon\n", "Yogurt", "Kale", KEY_AT_MAX_BYTES],
        category=[" Pork (pig meat) ", "Yogurt", "Vegetables", "Vegetables"],
        cleaned_item_names=["bacon", " ", None, np.nan],
    )

    inserted = cache_sync.push_product_categorizations(connection, frame, SUGGESTED_BY)

    assert inserted == 4
    assert connection.sent == [
        ("Bacon", "Pork (pig meat)", "bacon", SUGGESTED_BY),
        ("Yogurt", "Yogurt", None, SUGGESTED_BY),
        ("Kale", "Vegetables", None, SUGGESTED_BY),
        (KEY_AT_MAX_BYTES, "Vegetables", None, SUGGESTED_BY),
    ]


def test_push_turns_invisible_characters_into_a_space_the_lookup_ignores(
    caplog: pytest.LogCaptureFixture,
) -> None:
    connection: Any = _RecordingConnection()
    products = ["\ufeffYogurt\u200b ", "Bacon \r\n Bits", "Taco\u200bBeef", "Ta\xadco", "Kale "]
    caplog.set_level(logging.INFO, logger=cache_sync.__name__)

    cache_sync.push_product_categorizations(connection, _products(product=products), SUGGESTED_BY)

    keys = [row[0] for row in connection.sent]
    assert keys == ["Yogurt", "Bacon Bits", "Taco Beef", "Ta co", "Kale"]
    assert list(map(normalize_product_name, keys)) == list(map(normalize_product_name, products))
    assert caplog.messages[0] == (
        "Replaced invisible characters with a space in 4 products for product_categorization."
    )


def test_push_entree_classifications_sends_rows_the_checks_accept() -> None:
    connection: Any = _RecordingConnection()
    frame = _entrees(
        product=[" Taco ", "Rice\u200b"], entree_classification=["entree", "side/add-on"]
    )

    cache_sync.push_entree_classifications(connection, frame, SUGGESTED_BY)

    assert connection.sent == [
        ("Taco", "entree", SUGGESTED_BY),
        ("Rice", "side/add-on", SUGGESTED_BY),
    ]


def test_push_sends_only_the_first_row_of_a_repeated_key(caplog: pytest.LogCaptureFixture) -> None:
    connection: Any = _RecordingConnection()
    frame = _products(
        product=["Kale", " Kale\u200b", "Bacon"],
        category=["Vegetables", "Cheese", "Pork (pig meat)"],
        cleaned_item_names=["kale", "kale", "bacon"],
    )
    caplog.set_level(logging.INFO, logger=cache_sync.__name__)

    cache_sync.push_product_categorizations(connection, frame, SUGGESTED_BY)

    assert connection.sent == [
        ("Kale", "Vegetables", "kale", SUGGESTED_BY),
        ("Bacon", "Pork (pig meat)", "bacon", SUGGESTED_BY),
    ]
    assert caplog.messages == [
        "Replaced invisible characters with a space in 1 products for product_categorization.",
        "Skipping 1 product_categorization rows that repeat a key.",
        "Suggested 2 new product_categorization rows as lab:tester; 0 were already in the table.",
    ]


@pytest.mark.parametrize(
    ("push", "frame", "message"),
    [
        (
            cache_sync.push_product_categorizations,
            _products(product=[" ", "Kale"]),
            "Not pushing to product_categorization: 1 rows have a blank value, such as [' '].",
        ),
        (
            cache_sync.push_product_categorizations,
            _products(product=[np.nan]),
            "1 rows have a value that is not text, such as [nan].",
        ),
        (
            cache_sync.push_product_categorizations,
            _products(product=[f"{KEY_AT_MAX_BYTES}x"]),
            "1 rows have over 2000 bytes",
        ),
        (
            cache_sync.push_product_categorizations,
            _products(category=["\t"]),
            "1 rows have a blank value, such as ['\\t'].",
        ),
        (
            cache_sync.push_product_categorizations,
            _products(product=["\u200b"]),
            "1 rows have a blank value",
        ),
        (
            cache_sync.push_entree_classifications,
            _entrees(entree_classification=["unsure"]),
            "Not pushing to entree_classification: 1 rows have an unknown label",
        ),
    ],
)
def test_push_sends_nothing_when_a_row_would_fail_a_check(
    push: Callable[[Any, pd.DataFrame, str], int], frame: pd.DataFrame, message: str
) -> None:
    connection: Any = _RecordingConnection()

    with pytest.raises(ValueError, match=re.escape(message)):
        push(connection, frame, SUGGESTED_BY)

    assert connection.sent == []


@pytest.mark.parametrize(
    ("push", "frame"),
    [
        (cache_sync.push_product_categorizations, _products().iloc[:0]),
        (cache_sync.push_entree_classifications, _entrees().iloc[:0]),
    ],
)
def test_push_of_no_rows_sends_nothing(
    push: Callable[[Any, pd.DataFrame, str], int], frame: pd.DataFrame
) -> None:
    assert push(object(), frame, SUGGESTED_BY) == 0


def test_push_inserts_unverified_and_keeps_the_first_suggestion(
    test_database: psycopg.Connection,
) -> None:
    prefix = f"push-{uuid.uuid4()}"
    _insert(
        test_database,
        "product_categorization",
        ("product", "category", "is_verified"),
        [(f"{prefix} verified", "Yogurt", True)],
    )
    test_database.execute("SET LOCAL ROLE cache_client")
    products = _products(
        product=[f"{prefix} verified", f"{prefix} new"],
        category=["Cheese", "Pork (pig meat)"],
        cleaned_item_names=["cheese", None],
    )
    # The zero-width space would fail `entree_classification_product_no_invisible_characters`.
    entrees = _entrees(product=[f"{prefix} taco\u200b"])

    first = [
        cache_sync.push_product_categorizations(test_database, products, SUGGESTED_BY),
        cache_sync.push_entree_classifications(test_database, entrees, SUGGESTED_BY),
    ]
    second = [
        cache_sync.push_product_categorizations(test_database, products, "lab:other"),
        cache_sync.push_entree_classifications(
            test_database,
            _entrees(product=[f"{prefix} taco"], entree_classification=["side/add-on"]),
            "lab:other",
        ),
    ]

    assert (first, second) == ([1, 1], [0, 0])
    assert _select(test_database, "product_categorization", "product", prefix) == [
        (f"{prefix} new", "Pork (pig meat)", None, False, SUGGESTED_BY),
        (f"{prefix} verified", "Yogurt", None, True, "manual"),
    ]
    assert _select(test_database, "entree_classification", "product", prefix) == [
        (f"{prefix} taco", "entree", False, SUGGESTED_BY),
    ]


def _select(
    connection: psycopg.Connection, table: str, key: str, prefix: str
) -> list[tuple[Any, ...]]:
    cache = next(cache for cache in cache_sync.CACHE_TABLES if cache.table == table)
    query = sql.SQL(
        "SELECT {columns}, is_verified, suggested_by FROM {table} WHERE {key} LIKE {pattern} "
        "ORDER BY {key}"
    ).format(
        columns=sql.SQL(", ").join(map(sql.Identifier, cache.columns)),
        table=sql.Identifier(table),
        key=sql.Identifier(key),
        pattern=sql.Literal(f"%{prefix}%"),
    )
    with connection.cursor() as cursor:
        return cursor.execute(query).fetchall()


@pytest.mark.parametrize(
    ("entrees", "unsuggested"),
    [
        (None, "1 new categorizations"),
        (_entrees().iloc[:0], "1 new categorizations and 0 new entree classifications"),
    ],
    ids=["procurement", "serving"],
)
def test_unset_push_warns_with_what_it_leaves_unsuggested(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    entrees: pd.DataFrame | None,
    unsuggested: str,
) -> None:
    monkeypatch.setattr(cache_sync, "connect", _unexpected_connect)
    caplog.set_level(logging.WARNING, logger=cache_sync.__name__)

    cache_sync.push_suggestions_if_configured(_products(), entrees)

    assert caplog.messages == [
        f"CACHE_DB_CONNECTION_STRING is not set, so this run's {unsuggested} are not suggested "
        "to the cache, and the next run will ask the LLM again. See python/lab/README.md § "
        "Working on a client."
    ]


@pytest.mark.parametrize("with_entrees", [True, False])
def test_set_pushes_both_tables_over_one_connection(
    monkeypatch: pytest.MonkeyPatch, with_entrees: bool
) -> None:
    monkeypatch.setenv(VARIABLE, "postgresql://cache_client@db.example/postgres")
    monkeypatch.setattr(cache_sync, "lab_suggested_by", lambda: SUGGESTED_BY)
    connection = object()
    monkeypatch.setattr(cache_sync, "connect", lambda: contextlib.nullcontext(connection))
    pushes: list[tuple[str, object, pd.DataFrame, str]] = []
    for name in ("push_product_categorizations", "push_entree_classifications"):
        monkeypatch.setattr(
            cache_sync, name, lambda *args, name=name: pushes.append((name, *args)) or 0
        )
    products, entrees = _products(), _entrees()

    cache_sync.push_suggestions_if_configured(products, entrees if with_entrees else None)

    assert pushes == [
        ("push_product_categorizations", connection, products, SUGGESTED_BY),
        *([("push_entree_classifications", connection, entrees, SUGGESTED_BY)] * with_entrees),
    ]


def test_set_but_failing_push_says_the_output_is_written(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(VARIABLE, "postgresql://nobody@127.0.0.1:1/x")

    with pytest.raises(cache_sync.CacheSyncError) as raised:
        cache_sync.push_suggestions_if_configured(_products())

    assert str(raised.value) == (
        "Could not suggest this run's new answers to CACHE_DB_CONNECTION_STRING; the error above "
        "says why. The categorized output is already written."
    )
    assert isinstance(raised.value.__cause__, psycopg.OperationalError)


def test_lab_suggested_by_names_the_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cache_sync.getpass, "getuser", lambda: "ada")

    assert cache_sync.lab_suggested_by() == "lab:ada"


def _unexpected_connect() -> NoReturn:
    raise AssertionError("connected without CACHE_DB_CONNECTION_STRING")
