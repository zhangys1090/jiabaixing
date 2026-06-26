import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

PROJECT_ROOT = BASE_DIR.parent
ENV_FILE = PROJECT_ROOT / ".env"

if ENV_FILE.exists():
    with open(ENV_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("\"'")
            if key and value and not value.startswith("your_") and key not in os.environ:
                os.environ[key] = value

AGENT_HOST = os.getenv("AGENT_HOST", "0.0.0.0")
AGENT_PORT = int(os.getenv("AGENT_PORT", "3112"))

LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-4o-mini")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.7"))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "4096"))

CHROMA_PATH = os.getenv("CHROMA_PATH", str(DATA_DIR / "chroma"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR / 'agent.db'}")

TS_BACKEND_URL = os.getenv("TS_BACKEND_URL", "http://localhost:3111")
TS_BACKEND_TIMEOUT = float(os.getenv("TS_BACKEND_TIMEOUT", "30"))
MCP_CIRCUIT_THRESHOLD = int(os.getenv("MCP_CIRCUIT_THRESHOLD", "5"))
MCP_RECOVERY_TIMEOUT = float(os.getenv("MCP_RECOVERY_TIMEOUT", "30"))
TOOL_EXECUTE_TIMEOUT = float(os.getenv("TOOL_EXECUTE_TIMEOUT", "120"))
