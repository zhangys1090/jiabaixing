# 多阶段构建：家百星 V5.0 生产部署
# Stage 1: 前端构建
# Stage 2: 后端运行时

# ============ 前端构建 ============
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps
COPY src/frontend/ ./
RUN npm run build

# ============ 后端运行时 ============
FROM node:20-slim AS runtime

# 安装 better-sqlite3 编译依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装后端依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --legacy-peer-deps 2>/dev/null || npm install --omit=dev --legacy-peer-deps
RUN npm rebuild better-sqlite3

# 复制源码
COPY src/ ./src/
COPY tsconfig.json ./
COPY scripts/ ./scripts/

# 复制前端构建产物
COPY --from=frontend-builder /app/frontend/build ./src/frontend/build

# 创建数据目录
RUN mkdir -p /app/data /app/logs

# 环境变量
ENV NODE_ENV=production
ENV PORT=3111
ENV DATA_DIR=/app/data
ENV LOG_DIR=/app/logs

# 暴露端口
EXPOSE 3111

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "const http = require('http'); const req = http.get('http://localhost:3111/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.setTimeout(5000, () => { req.destroy(); process.exit(1); });"

# 启动
CMD ["npx", "tsx", "src/main.ts"]
