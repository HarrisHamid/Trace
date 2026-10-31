"""User lookup and authentication."""
from typing import Callable, Protocol
from taskboard.core.security import hash_password, verify_password
from taskboard.db import LoginForm, Session, Token, User, UserOut, select

class UserStore(Protocol):
    """Storage interface for users."""
    def find_by_email(self, email: str) -> User | None:
        """Look up a user row by email."""


class SqlUserStore(UserStore):
    """UserStore backed by the SQL session."""
    def __init__(self, session: Session) -> None:
        self.session = session

    def find_by_email(self, email: str) -> User | None:
        """Run a SELECT for the user with this email."""
        return self.session.scalar(select(User).where(User.email == email))


class UserService:
    """Authentication and user lookups."""

    def __init__(self, store: UserStore, rehash: Callable[[User, str], None] | None = None) -> None:
        self.store = store
        # Set by the app factory when old hashes need upgrading.
        self.rehash = rehash or (lambda user, password: None)
        self.hasher = hash_password

    def authenticate(self, email: str, password: str) -> User | None:
        """Return the user for an email and password, or None."""
        user = self.store.find_by_email(email)
        if user is None:
            return None
        if not verify_password(password, user.hashed_password):
            return None
        # self.rehash is assigned at runtime, so the parser cannot prove what it calls.
        self.rehash(user, password)
        return user

    def get(self, user_id: int) -> User | None:
        """Load a user by id."""
        return self.store.get(user_id)

    def rename(self, user: User, name: str) -> User:
        """Change a user's display name."""
        user.name = name
        return user

    def __repr__(self) -> str:
        return f"UserService({self.store!r})"
