# Python 后端 Dockerfile: 家百星核心 AI 逻辑
# 用途: 运行 Python Agent 后端（FastAPI + litellm + memory + loop + evolution）
# 端口: 8765

FROM python:3.13-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --no-cache-dir . 2>/dev/null || pip install --no-cache-dir -e .

COPY agent/ ./agent/
COPY scripts/ ./scripts/

RUN mkdir -p /app/data /app/logs

ENV PYTHONUNBUFFERED=1
ENV AGENT_HOST=0.0.0.0
ENV AGENT_PORT=8765
ENV DATA_DIR=/app/data
ENV LOG_DIR=/app/logs

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; r=urllib.request.urlopen('http://localhost:8765/health'); exit(0 if r.status==200 else 1)" || exit 1

CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
