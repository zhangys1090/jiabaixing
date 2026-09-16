# Jiabaixing 家百星 — 部署指南

> 版本状态：本文件对应当前仓库源码（package.json 5.0.0 / python 0.1.0，开发文档另有 6.x 版本表述，详见 README「项目状态」）。
> 最后核对：2026-09-16

本文说明如何把家百星跑起来：本机运行、Docker 运行，以及当前 CI/CD 的部署现状。

---

## 1. 本机运行（推荐先看这里）

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10+ | 主平台（Linux/macOS 部分支持） |
| Node.js | >= 20 | 运行 TS 网关与前端 |
| Python | >= 3.11 | 运行 Agent 内核（推荐 3.13） |
| LLM API Key | 任一 | DeepSeek / 小米 MiMo / OpenAI / 智谱 / 本地兼容端点 |

### Windows 运行

```powershell
git clone https://github.com/zhangys1090/jiabaixing.git
cd jiabaixing

# 1. Node 依赖
npm install

# 2. Python 依赖（进入 python/ 目录安装 agent 包）
cd python
python -m pip install -e .
cd ..

# 3. 配置 LLM
Copy-Item .env.example .env
# 编辑 .env 填入 API Key；或用交互式向导
npm run setup

# 4. 启动
npm run start          # 后端(:3111) + 前端开发服务器
# 或仅后端（前端使用已构建的静态页面）
npm run start:backend  # 访问 http://localhost:3111
```

### Linux / WSL 运行

```bash
bash install.sh   # 一键：环境检查 → npm install → LLM 配置向导
./run.sh          # 启动（后端 3111 + Python 后端 3112）
```

### 验证是否运行成功

```bash
curl http://localhost:3111/api/health
# 期望 {"status":"healthy", ..., "backend":"python"}
```

---

## 2. Docker 运行

仓库提供：

- `Dockerfile` — TS 网关镜像
- `python/Dockerfile` — Python Agent 后端镜像
- `docker-compose.yml` / `docker-compose.e2e.yml` — 编排与 E2E
- `deploy/kubernetes/` — K8s 部署清单（kustomize）

```bash
docker compose up -d
```

> 注意：Docker 编排当前以本地开发/自托管为主要目标；生产级配置（密钥注入、持久化、流量入口）需按环境补充。

---

## 3. CI/CD 部署现状（诚实说明）

- GitHub Actions（`.github/workflows/backend-ci-cd.yml`）会执行 lint / 类型检查 / E2E / 全量测试 / 覆盖率 / 构建，并把 `jiabaixing-gateway` 与 `jiabaixing-python-backend` 两个镜像推送到 GHCR。
- 仓库内置了 staging / production 两套部署工作流与 `deploy/kubernetes` 清单，但：
  - 工作流中的部署地址为占位域名（`*.jiabaixing.example.com`）；
  - 生产部署依赖仓库 Secrets（`KUBE_CONFIG_PROD` 等）与真实 kubeconfig，尚未接入真实集群。
- **因此目前没有对外提供托管服务（SaaS）**；家百星是本地运行的软件，部署到自有服务器需自行完成 K8s/密钥配置。
- TODO：接入真实部署环境后，此节将更新为实际地址与拓扑。

---

## 4. 环境变量（以 `.env.example` 为准）

要点：

| 分组 | 关键变量 | 说明 |
| --- | --- | --- |
| LLM | `DEEPSEEK_API_KEY` / `XIAOMI_API_KEY` / `OPENAI_API_KEY` / `ZHIPU_API_KEY` / `LLM_SERVER_BASE_URL` | 多 Provider 自动降级 |
| Embedding | `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | 未配置时降级为 hash 向量 |
| 安全 | `JWT_SECRET` / `AGENT_AUTHORITY_HMAC_SECRET` / `DASHBOARD_SECRET_KEY` | 生产必须设置为强随机值 |
| 缓存 | `CACHE_ENABLED` / `CACHE_TTL` | Redis 可用时启用 |
| 搜索 | `TAVILY_API_KEY` / `SEARXNG_BASE_URL` / `BRAVE_SEARCH_API_KEY` | Agent 联网检索 |

> 生产部署必须显式设置 `AGENT_AUTHORITY_HMAC_SECRET`（生成示例见 `.env.example` 内注释）。

---

## 5. 常见问题

| 现象 | 处理 |
| --- | --- |
| better-sqlite3 编译失败 | `npm run fix:native`（需要系统编译工具链） |
| esbuild 平台二进制错误 | `npm rebuild esbuild`（跨平台复制 node_modules 时常见） |
| 端口占用 | 设置 `PORT` 环境变量后重启 |
| 前端白屏 | 确认 `src/frontend/build` 存在；缺失时 `cd src/frontend && npm run build:fast` |
| Python 后端未就绪 | 启动日志见 `logs/python_backend.log`；确认 venv 已安装 `python/` 包 |

---

## 6. TODO（缺证据 / 待补充）

- [ ] 真实生产部署（当前为占位域名）
- [ ] 镜像版本 tag 与发布策略固化
- [ ] 一键安装脚本远程执行入口（域名或 raw 链接）
