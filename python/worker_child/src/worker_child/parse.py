"""Reading a contract document, without a validation library.

`worker_child` has no runtime dependencies, and this is the one place that would otherwise
justify one. The parent uses valibot, so the two sides do not share validation semantics — which
is why the golden fixtures in `contract/fixtures/` are load-bearing rather than decorative. Two
disagreements this file has to resolve deliberately, both pinned by fixtures:

- **`bool` is a subclass of `int`**, so a JSON `true` would sail through an `isinstance(v, int)`
  check as `1`. JavaScript has no such problem, so the trap is invisible from the other side.
- **`json.loads` distinguishes `1.0` from `1`, and `JSON.parse` cannot.** Valibot accepts both
  because `Number.isInteger(1.0)` is true, so this side accepts a float with no fractional part.
"""

import json
import re
from collections.abc import Mapping
from types import MappingProxyType
from typing import Any


class ContractError(Exception):
    """The other side of the seam wrote something we cannot accept."""


class Fields:
    """A cursor over one JSON object that records which keys it reads.

    `done()` then rejects whatever is left over, so refusing unknown fields costs nothing and
    cannot drift: there is no second list of field names to keep in step with the first. The
    mutable `_seen` set never escapes a parse function, which is what earns a class here.
    """

    def __init__(self, path: str, source: Mapping[str, Any]) -> None:
        self._path = path
        self._source = source
        self._seen: set[str] = set()

    def string(self, key: str) -> str:
        value = self._take(key)
        if not isinstance(value, str) or not value:
            raise self._fail(key, "a non-empty string")
        return value

    def nullable_string(self, key: str) -> str | None:
        value = self._take(key)
        if value is None:
            return None
        if not isinstance(value, str) or not value:
            raise self._fail(key, "a non-empty string or null")
        return value

    def integer(self, key: str, *, minimum: int = 0) -> int:
        return self._as_integer(key, self._take(key), minimum=minimum)

    def matching(self, key: str, pattern: re.Pattern[str]) -> str:
        value = self.string(key)
        if not pattern.fullmatch(value):
            raise self._fail(key, f"to match {pattern.pattern}")
        return value

    def literal[T: str](self, key: str, allowed: tuple[T, ...]) -> T:
        value = self.string(key)
        for candidate in allowed:
            if value == candidate:
                return candidate
        raise self._fail(key, f"one of {', '.join(allowed)}")

    def nested(self, key: str) -> "Fields":
        return Fields(f"{self._path}.{key}", self._object(key))

    def counts(self, key: str, month: re.Pattern[str]) -> Mapping[str, int]:
        raw = self._object(key)
        if not raw:
            raise self._fail(key, "at least one month")
        counts = {}
        for name, value in raw.items():
            if not month.fullmatch(name):
                raise ContractError(f"{self._path}.{key}: '{name}' is not a YYYY-MM month")
            counts[name] = self._as_integer(f"{key}.{name}", value, minimum=0)
        return MappingProxyType(counts)

    def done(self) -> None:
        extra = sorted(set(self._source) - self._seen)
        if extra:
            raise ContractError(f"{self._path}: unexpected field(s) {', '.join(extra)}")

    def _object(self, key: str) -> Mapping[str, Any]:
        value = self._take(key)
        # `dict` and not `Mapping`: `json.loads` produces dicts, and a list would otherwise slip
        # through any check based on "is it iterable".
        if not isinstance(value, dict):
            raise self._fail(key, "an object")
        return value

    def _as_integer(self, key: str, value: Any, *, minimum: int) -> int:
        expected = f"an integer >= {minimum}"
        if isinstance(value, bool):
            raise self._fail(key, expected)
        if isinstance(value, float):
            if not value.is_integer():
                raise self._fail(key, expected)
            value = int(value)
        if not isinstance(value, int) or value < minimum:
            raise self._fail(key, expected)
        return value

    def _take(self, key: str) -> Any:
        self._seen.add(key)
        if key not in self._source:
            raise self._fail(key, "to be present")
        return self._source[key]

    def _fail(self, key: str, expected: str) -> ContractError:
        return ContractError(f"{self._path}.{key}: expected {expected}")


def root_fields(document: str, text: str, version: int) -> Fields:
    """Parse `text` as a contract document and check its version before anything reads a field."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as cause:
        raise ContractError(f"{document}: not valid JSON") from cause
    if not isinstance(parsed, dict):
        raise ContractError(f"{document}: expected a JSON object")

    fields = Fields(document, parsed)
    if fields.integer("contractVersion", minimum=1) != version:
        raise ContractError(f"{document}: contractVersion must be {version}")
    return fields
