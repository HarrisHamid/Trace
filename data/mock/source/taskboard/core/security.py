"""Password hashing and token signing."""
from datetime import UTC, datetime
from taskboard.settings import ALGORITHM, SECRET_KEY, TOKEN_LIFETIME
import jwt
from passlib.hash import bcrypt

class TokenError(Exception):
    """The token is invalid or expired."""


def hash_password(password: str) -> str:
    """Hash a plain password with bcrypt."""
    return bcrypt.hash(password)

def verify_password(password: str, hashed: str) -> bool:
    """Check a plain password against a stored bcrypt hash."""
    return bcrypt.verify(password, hashed)


def create_access_token(user_id: int) -> str:
    """Sign a JWT for the given user id."""
    expires = datetime.now(UTC) + TOKEN_LIFETIME
    claims = {"sub": str(user_id), "exp": expires}
    token = jwt.encode(claims, SECRET_KEY, algorithm=ALGORITHM)
    # PyJWT 2 returns a str.
    return token


def decode_access_token(token: str) -> int:
    """Decode a JWT and return the user id, or raise TokenError."""
    try:
        claims = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError as error:
        # Expired and forged tokens fail the same way.
        raise TokenError(str(error)) from error
    else:
        return int(claims["sub"])


__all__ = ["create_access_token", "decode_access_token", "hash_password", "verify_password"]
