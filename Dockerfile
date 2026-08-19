# 多阶段构建：家百星 V5.0 生产部署
# Stage 1: 前端构建
# Stage 2: 后端（TS 网关）编译
# Stage 3: 运行时（仅运行编译产物 dist/，不再跑 TS 源码）

# ============ 前端构建 ============
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps
COPY src/frontend/ ./
RUN npm run build

# ============ 后端编译 ============
FROM node:20-slim AS backend-builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps
COPY src/ ./src/
COPY tsconfig.json ./
# 审计 P2-10：生产不再运行 TS 源码（tsx 为 devDep，离线镜像无 tsx 会失败）。
# 编译为 dist/ 后以 node dist/main.js 运行。
# P2-3 已清零全部 tsc 类型错误，故此处不再以 || 容错——类型退化必须阻断镜像构建。
RUN npm run build

# ============ 运行时 ============
FROM node:20-slim AS runtime

# 安装 better-sqlite3 编译依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装运行时依赖（仅生产依赖）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --legacy-peer-deps 2>/dev/null || npm install --omit=dev --legacy-peer-deps
RUN npm rebuild better-sqlite3

# 复制编译产物（来自后端编译阶段）
COPY --from=backend-builder /app/dist ./dist
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

# 启动：运行编译后的 JS（不再 npx tsx 跑源码）
CMD ["node", "dist/main.js"]
