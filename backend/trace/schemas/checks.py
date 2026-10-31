"""Tap-check contract: pre-generated questions, one per node."""

from collections import Counter
from typing import Self

from pydantic import model_validator

from .base import Contract


class CheckOption(Contract):
    id: str
    text: str


class Check(Contract):
    node_id: str
    question: str
    options: list[CheckOption]
    correct_option_id: str
    explanation: str

    @model_validator(mode="after")
    def options_are_consistent(self) -> Self:
        counts = Counter(option.id for option in self.options)
        dupes = sorted(oid for oid, n in counts.items() if n > 1)
        if dupes:
            raise ValueError(f"duplicate option ids: {dupes}")
        if self.correct_option_id not in counts:
            raise ValueError(f"correct_option_id {self.correct_option_id!r} is not an option")
        return self


class ChecksFile(Contract):
    repo: str
    checks: list[Check]
