from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All secrets/config come from environment variables or a .env file,
    so a backend restart never requires re-entering credentials."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="CONNECT_REMOTE_")

    # Connected Services account (Genesis / Kia Connect / Bluelink)
    username: str
    password: str
    pin: str

    # hyundai_kia_connect_api brand/region codes. Brand is fixed per deployment
    # (3 = Genesis); region must match the account's home region (1 = EU).
    brand: int = 3
    region: int = 1

    # Static bearer token for app/Siri -> backend auth
    api_token: str

    # /refresh throttling
    refresh_min_interval_seconds: int = 900  # 15 min between force refreshes
    refresh_daily_cap: int = 20

    # Comma-separated CORS origins; "*" for any (fine: auth is bearer, not cookies)
    cors_origins: str = "*"


settings = Settings()
