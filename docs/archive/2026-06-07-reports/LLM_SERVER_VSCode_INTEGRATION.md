# 将 LLM.server 接入 VS Code（本地开发）

下面的步骤帮助你在本地将项目配置为使用 LLM.server（OpenAI 兼容接口），并在 VS Code 中方便地启动与调试后端/前端。

- 前提：本地已运行 LLM.server，或可访问 `OPENAI_API_BASE` 指向的地址（示例：`http://127.0.0.1:8001/v1`）。

1. 复制环境文件

   在仓库根目录执行：

   ```powershell
   copy .env.example .env
   ```

   根据实际情况修改 `.env` 中的 `OPENAI_API_BASE`、`LLM_MODEL` 等变量。

2. 安装依赖

   ```powershell
   npm install
   cd src/frontend
   npm install
   ```

3. 在 VS Code 中使用已添加的任务与调试配置

   - 启动后端（在运行/调试侧栏选择 `Launch Backend` 或运行任务 `启动后端服务`）。
   - 启动前端（选择 `Launch Frontend` 或运行任务 `启动前端开发服务器`）。

   两个 Launch 配置会从根目录的 `.env` 加载环境变量（通过 `envFile`）。

4. 验证 LLM.server 通信（可在终端或 curl）

   ```powershell
   curl -X POST "${env:OPENAI_API_BASE}/chat/completions" -H "Content-Type: application/json" -d '{"model":"qwen2.5:3b","messages":[{"role":"user","content":"Hello"}] }'
   ```

   如果 LLM.server 不需要 API key，上面应该返回模型输出；否则按服务要求加入 `Authorization` 头。

5. 常见问题

- 如果后端报无法连接 LLM.server：确认 `.env` 的 `OPENAI_API_BASE` 是否正确并且 LLM.server 正在运行。
- 如果需要 HTTP 代理或不同端口：在 `.env` 中修改 `OPENAI_API_BASE` 并重启后端。

6. 可选：在 VS Code 的 `launch.json` 中添加更多调试参数

   我已经添加了基本的 `Launch Backend` 与 `Launch Frontend` 配置，若需附加调试参数（例如 `--inspect` 或自定义 `NODE_OPTIONS`），可在 [\.vscode/launch.json](.vscode/launch.json) 中扩展对应配置。

7. 下一步建议

- 若你使用的是需要认证的 LLM.server，请把密钥安全地存入系统密钥管理器或 CI 变量，而不要提交到仓库。
- 想让我把启动脚本改为同时监控后端并在后端就绪后自动打开前端，我可以继续实现并添加到 `tasks.json`。
