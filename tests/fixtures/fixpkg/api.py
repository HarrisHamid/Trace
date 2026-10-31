"""Fixture module with known edges. Line numbers are asserted in tests."""
from typing import Annotated

from fastapi import APIRouter, Depends

from fixpkg import helpers
from fixpkg.deps import RepoDep, get_repo
from fixpkg.helpers import Repo, helper
from fixpkg.helpers import compute as calc

router = APIRouter(prefix="/things")


def local_fn(x):
    return x + 1


def plain_caller():
    return local_fn(1)  # plain function call (line 19)


def uses_import():
    return helper(2)  # imported function (line 23)


def uses_alias():
    return calc(1, 2)  # aliased import (line 27)


def uses_module_attr():
    return helpers.compute(3, 4)  # module attribute (line 31)


class Service:
    def run(self):
        return self.step()  # method via self (line 36)

    def step(self):
        return Repo()  # class instantiation (line 39)


def dynamic(obj):
    return getattr(obj, "save")()  # dynamic -> uncertain (line 43)


def apply(callback, value):
    return callback(value)  # callback -> uncertain (line 47)


def uses_callback():
    return apply(local_fn, 3)  # resolved call to apply (line 51)


def nested_and_lambda():
    def inner():
        return helper(5)  # attributed to nested_and_lambda (line 56)

    f = lambda: local_fn(6)  # attributed to nested_and_lambda (line 58)
    return inner, f


@router.get("/{thing_id}")
def read_thing(thing_id: int, repo: RepoDep, other: Repo = Depends(get_repo)):
    return repo.save(thing_id)


@router.post("/", dependencies=[Depends(get_repo)])
def create_thing(repo: Annotated[Repo, Depends(get_repo)]):
    return len("x")  # builtin -> external, no edge (line 69)


local_fn(0)  # module-level call -> attributed to module (line 72)
