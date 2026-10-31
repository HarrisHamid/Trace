"""Settings, read from the environment and .env."""

from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    # No defaults for the model API: its values live in .env (see .env.example).
    meta_api_key: SecretStr = SecretStr("")
    meta_base_url: str = ""
    meta_model: str = ""

    trace_data_dir: Path = REPO_ROOT / "data" / "mock"
    trace_source_dir: Path = REPO_ROOT / "data" / "mock" / "source"
    trace_web_dist: Path = REPO_ROOT / "web" / "dist"
    trace_replay_delay_seconds: float = 0.3
