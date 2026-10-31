"""Login and session routes."""

from fastapi import APIRouter, HTTPException
from taskboard.api.deps import CurrentUser, UserServiceDep
from taskboard.core.security import create_access_token
from taskboard.services.users import LoginForm, Token, UserOut

# Mounted at the app root, so the paths here are absolute.
router = APIRouter()


@router.post("/api/login")
async def login(form: LoginForm, users: UserServiceDep) -> Token:
    """Exchange an email and password for an access token."""
    # The service returns None for any failed check.
    user = users.authenticate(form.email, form.password)
    if user is not None:
        # The token carries only the user id.
        return Token(access_token=create_access_token(user.id))

    raise HTTPException(status_code=401, detail="Invalid email or password")


@router.get("/api/me")
async def read_me(user: CurrentUser) -> UserOut:
    """Return the logged-in user."""
    return UserOut.model_validate(user)


__all__ = ["router"]
