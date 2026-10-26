"""
Cache Sync
==========

Pulls the verified rows of the database's two caches into the CSV files the lab's loaders read,
so every loader, runscript and notebook reads the database's answers unchanged, and offline. Pushes
the lab's new answers back as unverified suggestions, which nobody uses until a human verifies
them in Supabase Studio; the next pull then brings them down.

The database is `CACHE_DB_CONNECTION_STRING`'s, the variable a developer's worker reads too: as
`cache_client`, which can only read the caches and suggest rows to them. Never
`DB_CONNECTION_STRING`, which is `postgres`.

    python -m gbd_foodservice_insights_lab.cache_sync    # or `just pull-caches`
"""

import getpass
import logging
import os
import re
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
from psycopg.conninfo import conninfo_to_dict

from gbd_foodservice_insights_lab.categorization import entree_cache, product_cache

logger = logging.getLogger(__name__)

CONNECTION_STRING_VARIABLE: Final = "CACHE_DB_CONNECTION_STRING"
_SETUP_DOC: Final = "python/lab/README.md § Working on a client"
# The hosts a local Supabase stack answers on, as `@gbd/db`'s `connection-string.ts` lists them.
_LOCAL_HOSTS: Final = frozenset({"localhost", "127.0.0.1", "host.docker.internal"})
_HOSTED_ROLE: Final = "cache_client"

# `MAX_CACHE_KEY_BYTES` in `@gbd/db`, the bound the cache tables' CHECKs enforce, in UTF-8.
MAX_CACHE_KEY_BYTES: Final = 2000
# What the cache tables' `*_product_no_invisible_characters` CHECKs refuse in a product: a control
# character, such as a line break, or a format character, such as a zero-width space.
_INVISIBLE: Final = (
    r"\x00-\x1f\x7f-\x9f\xad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff"
)
# A run of them, with the whitespace around it. A push turns each into one space. That is safe
# because a product lookup falls back to ignoring spacing and punctuation
# (`normalize_product_name`), so the product as the client's file spells it still finds the key.
_INVISIBLE_RUN: Final = re.compile(rf"[\s{_INVISIBLE}]*[{_INVISIBLE}][\s{_INVISIBLE}]*")

# `entree_classification_label`'s values.
_ENTREE_LABELS: Final = frozenset(
    {entree_cache.ENTREE_LABEL_ENTREE, entree_cache.ENTREE_LABEL_SIDE_ADDON}
)


class CacheSyncError(RuntimeError):
    """The caches could not be pulled or pushed, for a reason whoever runs the lab must fix."""


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


PRODUCT_CATEGORIZATION: Final = CacheTable(
    table="product_categorization",
    columns={
        "product": "product",
        "category": "category",
        "cleaned_name": "cleaned_item_names",
    },
    path=lambda: product_cache.categorization_cache_path(),
)
ENTREE_CLASSIFICATION: Final = CacheTable(
    table="entree_classification",
    columns={
        "product": "product",
        "classification": "entree_classification",
    },
    path=lambda: entree_cache.get_previously_classified_entrees_location(),
)
CACHE_TABLES: Final = (PRODUCT_CATEGORIZATION, ENTREE_CLASSIFICATION)


def connect() -> psycopg.Connection:
    """Open it per command, as `with connect() as connection:`. One kept in a notebook global is
    closed by the role's 10-minute idle-session timeout."""
    conninfo = os.environ.get(CONNECTION_STRING_VARIABLE)
    if not conninfo:
        raise CacheSyncError(f"{CONNECTION_STRING_VARIABLE} is not set; see {_SETUP_DOC}.")
    _refuse_hosted_unless_cache_client(conninfo)
    # Autocommit, so a connection never sits idle in a transaction, where it would block every
    # other insert of a key it inserted. `connect_timeout`, since libpq otherwise waits forever on
    # an unreachable host. The string's own `sslmode` and `sslrootcert` carry the TLS.
    return psycopg.connect(
        conninfo, autocommit=True, connect_timeout=10, application_name="lab-cache"
    )


def _refuse_hosted_unless_cache_client(conninfo: str) -> None:
    """The lab never needs more than `cache_client` on the hosted project, so a string holding
    `postgres` there is a mistake, not a choice. The pooler spells the role `cache_client.<ref>`."""
    params = conninfo_to_dict(conninfo)
    # libpq connects to `hostaddr` when both are given.
    host = str(params.get("hostaddr") or params.get("host") or "")
    user = str(params.get("user", ""))
    if host in _LOCAL_HOSTS or user == _HOSTED_ROLE or user.startswith(f"{_HOSTED_ROLE}."):
        return
    raise CacheSyncError(
        f"Refusing to connect to {host or 'an unnamed host'} as {user or 'an unnamed user'}: "
        f"{CONNECTION_STRING_VARIABLE} must hold {_HOSTED_ROLE} on a hosted database; see "
        f"{_SETUP_DOC}. AI agents: stop and ask a human."
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
        raise CacheSyncError(
            f"Could not pull the caches from {CONNECTION_STRING_VARIABLE}; the error above says "
            f"why. To run on the cache files on disk instead, comment {CONNECTION_STRING_VARIABLE} "
            "out in .env."
        ) from error


def lab_suggested_by() -> str:
    """The `suggested_by` of a row the lab pushes, so a reviewer knows whom to ask."""
    return f"lab:{getpass.getuser()}"


def push_suggestions_if_configured(
    products: pd.DataFrame, entrees: pd.DataFrame | None = None
) -> None:
    """Step 1's push of its new answers, in the categorization and entree files' columns."""
    if not os.environ.get(CONNECTION_STRING_VARIABLE):
        logger.warning(
            "%s is not set, so this run's %d new categorizations%s are not suggested to the "
            "cache, and the next run will ask the LLM again. See %s.",
            CONNECTION_STRING_VARIABLE,
            len(products),
            "" if entrees is None else f" and {len(entrees)} new entree classifications",
            _SETUP_DOC,
        )
        return

    suggested_by = lab_suggested_by()
    try:
        with connect() as connection:
            push_product_categorizations(connection, products, suggested_by)
            if entrees is not None:
                push_entree_classifications(connection, entrees, suggested_by)
    except psycopg.Error as error:
        raise CacheSyncError(
            f"Could not suggest this run's new answers to {CONNECTION_STRING_VARIABLE}; the error "
            "above says why. The categorized output is already written."
        ) from error


# Each push inserts its rows unverified and skips every key the table already holds, verified or
# not: the first suggestion wins, and a correction happens in Studio. Each first makes its rows
# pass the table's CHECKs, since one rejected row fails the whole push. Each returns how many rows
# it inserted.


def push_product_categorizations(
    connection: psycopg.Connection, frame: pd.DataFrame, suggested_by: str
) -> int:
    rows = frame.assign(
        product=_product_keys(PRODUCT_CATEGORIZATION, frame["product"]),
        category=_stripped_text(PRODUCT_CATEGORIZATION, frame["category"]),
        cleaned_item_names=_optional_text(frame["cleaned_item_names"]),
    )
    return _push(connection, PRODUCT_CATEGORIZATION, rows, suggested_by)


def push_entree_classifications(
    connection: psycopg.Connection, frame: pd.DataFrame, suggested_by: str
) -> int:
    labels = frame["entree_classification"]
    _reject(ENTREE_CLASSIFICATION, labels, ~labels.isin(_ENTREE_LABELS), "an unknown label")
    rows = frame.assign(product=_product_keys(ENTREE_CLASSIFICATION, frame["product"]))
    return _push(connection, ENTREE_CLASSIFICATION, rows, suggested_by)


def _product_keys(cache: CacheTable, products: pd.Series) -> pd.Series:
    """Stripped, as the pipeline strips an upload's products before it looks them up."""
    _reject(cache, products, ~_is_text(products), "a value that is not text")
    spaced = products.map(lambda product: _INVISIBLE_RUN.sub(" ", product))
    if n_spaced := int((spaced != products).sum()):
        logger.info(
            "Replaced invisible characters with a space in %d products for %s.",
            n_spaced,
            cache.table,
        )
    keys = _stripped_text(cache, spaced)
    _reject(cache, keys, _over_key_bytes(keys), f"over {MAX_CACHE_KEY_BYTES} bytes")
    return keys


def _stripped_text(cache: CacheTable, values: pd.Series) -> pd.Series:
    _reject(cache, values, ~_is_text(values), "a value that is not text")
    _reject(cache, values, ~_has_text(values), "a blank value")
    return values.map(str.strip)


def _optional_text(values: pd.Series) -> pd.Series:
    """Missing for anything without a non-space character, which the CHECKs would reject."""
    return values.where(_has_text(values))


# `map`, not the `.str` accessor, which refuses a column that is all missing, and `astype(bool)`,
# since `map` keeps an empty column's dtype.


def _is_text(values: pd.Series) -> pd.Series:
    return values.map(lambda value: isinstance(value, str)).astype(bool)


def _has_text(values: pd.Series) -> pd.Series:
    """Text with a character `str.strip` keeps, as the tables' `[^[:space:]]` CHECKs require."""
    return values.map(lambda value: isinstance(value, str) and bool(value.strip())).astype(bool)


def _over_key_bytes(keys: pd.Series) -> pd.Series:
    return keys.map(lambda key: len(key.encode("utf-8")) > MAX_CACHE_KEY_BYTES).astype(bool)


def _reject(cache: CacheTable, keys: pd.Series, rejected: pd.Series, reason: str) -> None:
    """Fail the push before it sends anything, naming the first few keys."""
    if not rejected.any():
        return
    examples = keys[rejected].head(5).tolist()
    raise ValueError(
        f"Not pushing to {cache.table}: {int(rejected.sum())} rows have {reason}, such as "
        f"{examples!r}."
    )


def _push(
    connection: psycopg.Connection, cache: CacheTable, frame: pd.DataFrame, suggested_by: str
) -> int:
    # Two products can share a key once cleaned, such as `Kale` and `Kale\n`. The table would keep
    # the first suggestion, so only that one is sent.
    repeats = frame[cache.key].duplicated()
    if repeats.any():
        logger.info("Skipping %d %s rows that repeat a key.", int(repeats.sum()), cache.table)
    frame = frame.loc[~repeats]

    # Only the columns `cache_client` may insert, so every row lands unverified.
    columns = [*cache.columns, "suggested_by"]
    query = sql.SQL(
        "INSERT INTO {table} ({columns}) VALUES ({values}) ON CONFLICT ({key}) DO NOTHING"
    ).format(
        table=sql.Identifier(cache.table),
        columns=sql.SQL(", ").join(map(sql.Identifier, columns)),
        values=sql.SQL(", ").join(sql.Placeholder() * len(columns)),
        key=sql.Identifier(cache.key),
    )
    rows = frame[list(cache.columns.values())].assign(suggested_by=suggested_by)
    # psycopg sends a NaN as the text 'NaN', which a text column would store.
    rows = rows.astype(object).where(rows.notna(), None)
    if rows.empty:
        logger.info("No new %s rows to suggest.", cache.table)
        return 0
    # One transaction, so a push that fails partway inserts nothing and can simply be rerun.
    # `executemany` pipelines the statements, so the rows take one round trip, not one each.
    with connection.transaction(), connection.cursor() as cursor:
        cursor.executemany(query, rows.itertuples(index=False, name=None))
        inserted = cursor.rowcount

    logger.info(
        "Suggested %d new %s rows as %s; %d were already in the table.",
        inserted,
        cache.table,
        suggested_by,
        len(rows) - inserted,
    )
    return inserted


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
