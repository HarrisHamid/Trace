"""Dependencies that are not plain functions."""

from typing import Annotated

from fastapi import Depends
from fastapi.security import OAuth2PasswordRequestForm


class Bearer:
    def __call__(self):
        return "token"


bearer = Bearer()


def by_variable(token: Annotated[str, Depends(bearer)]):
    return token


def by_library_class(form: Annotated[OAuth2PasswordRequestForm, Depends()]):
    return form


def by_lambda(value=Depends(lambda: 1)):
    return value
