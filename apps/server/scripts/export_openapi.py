from __future__ import annotations

import json
import os
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_ROOT))

# Schema generation uses the isolated dev/local contract and never publishes a build.
os.environ["PORTFOLIO_BRANCH"] = "dev"
os.environ["PORTFOLIO_AUTH_MODE"] = "local"

from app.main import create_app  # noqa: E402


def main() -> None:
    target = SERVER_ROOT / "openapi.json"
    payload = json.dumps(create_app().openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    target.write_text(payload, encoding="utf-8")


if __name__ == "__main__":
    main()
