"""Settings read from environment variables. Nothing secret has a default."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str                       # https://xyz.supabase.co
    supabase_anon_key: str                  # public key, used to verify user tokens
    supabase_service_role_key: str          # secret: bypasses RLS, used only for AI write-back, cron and demo reset

    gemini_api_key: str = ""                # empty -> rule-based fallbacks, clearly labelled
    gemini_model: str = "gemini-3.8-flash"

    resend_api_key: str = ""                # empty -> notifications stay in-app only
    email_from: str = "OpenBench <noreply@openbench.example>"
    app_url: str = "http://localhost:8081"

    cron_secret: str = ""                   # required to call /cron/tick
    allowed_origins: str = "http://localhost:8081,http://localhost:19006"

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
