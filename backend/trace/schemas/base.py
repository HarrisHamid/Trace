"""Shared base for contract models."""

from pydantic import BaseModel, ConfigDict


class Contract(BaseModel):
    """Rejects unknown fields, so a typo in a fixture fails instead of being dropped."""

    model_config = ConfigDict(extra="forbid")
