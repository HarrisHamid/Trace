"""FastAPI dependencies."""
from typing import Annotated, Iterator
from taskboard.core.security import decode_access_token
from taskboard.services.users import SqlUserStore, User, UserService
from taskboard.db import Depends, HTTPException, Session, TokenDep, engine
def get_session() -> Iterator[Session]:
    """Yield a database session for one request."""
    with Session(engine) as session:
        yield session
SessionDep = Annotated[Session, Depends(get_session)]
def get_user_service(session: SessionDep) -> UserService:
    store = SqlUserStore(session)  # Build a UserService on the request's session.
    return UserService(store)
UserServiceDep = Annotated[UserService, Depends(get_user_service)]
def get_current_user(token: TokenDep, users: UserServiceDep) -> User:
    """Resolve the bearer token to a user, or reject the request."""
    user_id = decode_access_token(token)  # The app turns TokenError into a 401.
    # The token can outlive its user.
    user = users.get(user_id)
    if user is None: raise HTTPException(status_code=401, detail="Unknown user")
    return user

CurrentUser = Annotated[User, Depends(get_current_user)]
__all__ = ["CurrentUser", "UserServiceDep"]
