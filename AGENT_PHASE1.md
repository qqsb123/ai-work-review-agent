> 历史 Node Phase 1 资料，不是当前主实现。最终 Python/FastAPI 版本见 README 与 AGENT_PROJECT_LEARNING。

# 第一阶段：Agent 基础架构与跨周趋势复盘

> 本文保留 Phase 1 的历史设计与验收。最终项目已完成追问、计划跟踪和工程收尾，配置、数据库及保存行为以 README.md、AGENT_PROJECT_LEARNING.md 为准。

本阶段实现正式 Tool Calling、受控 Agent Loop、历史周报检索、原文引用校验、进度展示和停止分析。范围止于复盘，不实施信息追问、待办创建或计划状态跟踪。复盘接口仅执行 SELECT，不修改周报，也不保存分析结果。

## 使用与配置

按 README 启动 MySQL、后端和前端，登录已有账号。至少保留两份历史周报，在“Agent 工作趋势复盘”中点击“生成趋势洞察”。可选填写复盘重点，例如“权限模块推进情况，以及反复出现的阻塞”；这是单次分析输入，不是追问会话。完成后点击“查看依据”查看引用与本次读取的正文快照。

不需要数据库迁移或新增依赖。Agent 使用已有 `DEEPSEEK_API_KEY`；可在 `server/.env` 设置 `DEEPSEEK_AGENT_MODEL`，默认 `deepseek-flash`。普通周报生成和 AI 重写继续使用原有模型配置。需要 Node.js 20.3+，现有 Node 20 Docker/CI 镜像满足要求。

适配依据：[DeepSeek Tool Calling](https://api-docs.deepseek.com/guides/tool_calls/) 和 [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。采用非思考模式与非流式完整响应来读取 `tool_calls`，网页通过 SSE 接收执行进度和校验后的最终结果，不展示内部推理文本。

## 核心调用链

```text
App.vue：复盘重点 / 开始 / 停止
  → api/ai.ts → api/sse.ts：POST /api/ai/insights
  → authMiddleware → aiRateLimit
  → insightsHandler：输入与历史数量校验、同用户并发控制、SSE
  → insightsAgent：任务规则、当前用户上下文、独立证据 Map
  → runAgent：多轮模型调用、工具结果回传、预算、终止和修订
  → createDeepSeekCompletion：DeepSeek /chat/completions
      ↔ toolRegistry：白名单和参数校验
      ↔ reportTools：MySQL 用户范围内的 SELECT
  → insightsResult：结构与原文引用校验
  → SSE result + [DONE]
  → InsightsResult.vue：结论与证据快照
```

## Tool Calling

`toolRegistry.js` 将工具定义转成 API 的 `tools` 数组，每项为 `type: "function"`，附名称、说明和 JSON Schema。模型返回 `assistant.tool_calls` 后由服务端执行对应函数，模型本身不执行 SQL。

- `search_reports({ keyword?, limit?, offset? })`：按创建时间和 ID 倒序检索。默认每页 6 条，最多 10 条，offset 0–40。关键词最长 80 字，使用参数化 `LOCATE` 查找正文，避免 `%`、`_` 被当作通配符。返回 ID、创建/更新时间、最多 300 字的摘要和分页信息。摘要不能用作最终引用。
- `read_report({ reportId })`：查询 `WHERE id = ? AND user_id = ?`，返回当前保存的 `content`，最多 6000 字，超长显式标记。单次最多读取 8 份不同正文，重复读取复用同一快照。

工具参数没有 userId、SQL 或写入指令。身份从 JWT 得到，由服务端通过上下文注入。所有参数再次在本地校验；未知工具、非法 JSON、多余字段、错误类型和越界参数均不触发数据库查询。

消息与工具结果按正式协议回传：

```text
assistant: tool_calls=[{ id: "call_1", function: { name: "read_report", arguments: "{...}" } }]
tool:      tool_call_id="call_1", content="工具结果 JSON"
assistant: 下一轮继续检索，或输出最终 JSON
```

完整保留 assistant 消息，包括上游可能返回的 reasoning_content，但不发送给浏览器。每个工具结果使用相应 tool_call_id。工具输入错误可回传给模型修正；数据库和模型服务异常直接终止，不自动重复付费调用。

## Agent Loop

每轮携带系统规则、用户复盘重点、此前模型消息、工具结果和工具 Schema。模型选择继续搜索、读取原文或输出结果；服务端不预先固定全部查询顺序。

1. 检查取消状态、上下文和累计 Token 预算。
2. 调用模型，检查结束原因、usage 和响应格式。
3. 有工具调用：验证数量与唯一 ID，逐个执行白名单工具，将结果回传，进入下一轮。
4. 无工具调用：校验最终四个分析数组及引用。
5. 通过才返回结果。失败时反馈具体校验问题，在同一总预算内最多修订两次；预算耗尽则返回明确错误。

默认限制定义在 `DEFAULT_AGENT_LIMITS`：8 轮模型响应、12 次工具调用、每轮最多 6 个工具、每次最多 3000 输出 Token、累计 80000 Token、50000 字符的序列化上下文、180 秒总循环耗时、两次最终修订。一次读取最多 8 份正文。

每次请求前用序列化消息与工具 Schema 的 UTF-8 字节数保守预留输入预算，再限制输出 Token。有 usage 时累计实际值，无 usage 时保守计入并标记 usageEstimated。该保护不是精确金额报价，保守估算可能让长正文分析提前结束。

预检查询最多等待 10 秒。同一用户在当前后端进程同时只能进行一次复盘，冲突返回 409。点击停止或触发超时会中断上游模型请求并停止后续循环；已发往 MySQL 的只读查询可能仍执行，但迟到结果会被丢弃。并发锁、限流和任务状态是单实例实现，没有添加 Redis 或后台任务队列。

## 结果与证据边界

最终 JSON 包含 workstreams、continuity、recurringProblems、suggestions 四个数组，每项为 `{ text, evidence: [{ reportId, quote }] }`。每类最多 4 项，每项最多 4 条引用。

服务端校验：

- 至少通过工具读取两份不同周报。
- 引用必须来自本次已读取记录，quote 是工具返回正文中的连续片段，长度 6–400 字；只规范化空白，不能改写或引用截断范围外的内容。
- 连续性与反复问题的每条结论必须引用至少两份不同记录。
- 有结论时全篇至少引用两份记录；完全没有充分证据时允许四个数组全空，明确说明证据不足。
- 返回本次读取的正文快照、创建/更新时间、截断标记、数据局限和运行指标。

校验能证明引用存在且来自本次读取，不能证明引用在语义上充分支持所有结论。用户仍需核对，本阶段没有第二个评审 Agent。界面使用 Vue 文本插值展示结论、引用和正文，不将 Agent 输出作为 HTML 执行。

数据库暂时没有所属周期和版本字段。创建时间只能排序，不能将 N 份记录等同于 N 周。只有正文明确说明周期时才具备相应跨周依据，结果始终提示这一局限；本阶段没有推测或回填旧记录周期。

## SSE 与运行记录

保留 `POST /api/ai/insights`，请求为 `{ "question": "可选复盘重点" }`，发送 `{}` 也能开始分析。复盘响应已改为结构化结果，外部消费者需要适配。

- progress：stage 与面向用户的 message，不包含内部推理。
- result：sections、sources、limitations、metrics、runId。
- [DONE]：仅成功输出结果后发送。
- error：安全的错误码和提示，失败不发送结果或完成标记。
- 每 15 秒发送 SSE 注释心跳。

前端必须同时收到 result 与 [DONE] 才展示复盘结果，断流被识别为失败。普通周报生成与重写仍使用原有 content 事件，新增 SSE 回调为可选扩展。

成功日志记录 runId、用户 ID、轮次、工具次数、Token、修订次数与耗时；失败日志记录 runId 和错误码。不打印凭证、用户问题、正文或完整上游错误对象。运行记录未持久化到数据库。

## 验证

```text
cd server
npm test
npm run verify:agent

cd ../client
npm test
npm run build
```

verify:agent 使用真实 DeepSeek 服务和两份合成周报，验证生产模型适配器与完整循环，不连接真实用户数据。需要有效 API Key，会产生少量模型调用费用。

验收覆盖后端 19 项测试、前端 4 项测试、Vue/TypeScript 类型检查与生产构建。真实 API 验证得到 3 轮模型响应、4 次工具调用、4507 Token、0 次修订，生成四类分析并通过引用校验。MySQL 实际执行新查询成功，限定 userId=0，没有读取真实用户正文。

自动化覆盖工具参数与权限、分页与截断、消息回传、无效引用修订、证据不足、循环预算、停止与超时、SSE 完成/断流、同用户并发、异常脱敏及原有 content 流兼容性。真实 API 统计来自合成数据验收，不代表线上质量或性能基准。

## 全部文件清单

新增：

- `server/agents/errors.js`：Agent 与工具输入错误。
- `server/agents/toolRegistry.js`：工具白名单、API Schema、本地参数校验。
- `server/agents/runAgent.js`：通用循环、预算、取消、usage、有限修订。
- `server/agents/reportTools.js`：搜索、读取、用户隔离与证据快照。
- `server/agents/insightsResult.js`：结构化结果与原文引用校验。
- `server/agents/insightsAgent.js`：复盘规则和上下文组装。
- `server/agents/insightsHandler.js`：HTTP/SSE 生命周期、并发锁与错误处理。
- `server/tests/agent.test.js`：Agent 与工具测试。
- `server/tests/insightsHandler.test.js`：接口与生命周期测试。
- `server/scripts/verify-agent.mjs`：合成周报的真实 API 验收。
- `client/src/components/InsightsResult.vue`：结果与证据查看。
- `client/tests/sse.test.mjs`：前端协议测试。
- `AGENT_PHASE1.md`：本说明。

修改：

- `server/services/deepseek.js`：Tool Calling 的完整响应适配器。
- `server/routes/ai.js`：复盘路由接到 Agent。
- `server/.env.example`：Agent 模型配置示例。
- `server/package.json`：真实 API 验收命令。
- `client/src/api/sse.ts`：progress/result 回调与完整结果检查。
- `client/src/api/ai.ts`：复盘输入与结果类型。
- `client/src/App.vue`：复盘重点、进度、结果、失败与停止交互。
- `client/src/style.css`：复盘与原文查看样式。
- `client/package.json`：前端测试命令。
- `.github/workflows/ci.yml`：加入前端协议测试。
- `.gitignore`：忽略类型检查生成的 tsbuildinfo。
- `README.md`、`UPGRADE_NOTES.md`：当前功能与阶段说明。

原有 buildInsightsPrompt 保留用于兼容历史提示词测试，复盘路由已不再调用它。

