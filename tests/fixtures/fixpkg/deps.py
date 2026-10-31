from typing import Annotated

from fastapi import Depends

from fixpkg.helpers import Repo


def get_repo() -> Repo:
    return Repo()


RepoDep = Annotated[Repo, Depends(get_repo)]
