"""Interfaces and their implementations."""

from abc import ABC, abstractmethod
from typing import Generic, TypeVar

T = TypeVar("T")


class Store(ABC):
    @abstractmethod
    def load(self, key):
        """Fetch one value."""

    def flush(self):
        raise NotImplementedError

    def size(self):
        return 0


class MemoryStore(Store):
    def load(self, key):
        return key

    def flush(self):
        return None

    def size(self):  # overrides a concrete method, so this is not `implements`
        return 1


class DiskStore(Store):
    def load(self, key):
        return key


class Base(Generic[T]):
    def get(self) -> T: ...


class IntBase(Base[int]):  # a subscripted base still inherits
    def get(self) -> int:
        return 1
