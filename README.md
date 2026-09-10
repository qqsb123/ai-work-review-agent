# AI 智能工作复盘平台 · Portfolio Edition

一个面向实习/作品集展示的全栈 AI 应用。项目不只“调用大模型 API”，而是把 **用户系统、JWT 鉴权、MySQL 数据隔离、SSE 流式输出、历史上下文增强、AI 二次编辑、跨周趋势复盘、CRUD 与限流** 串成完整业务闭环。

## 技术栈

- Frontend: Vue 3 + TypeScript + Vite + Element Plus + Marked
- Backend: Node.js + Express
- Database: MySQL 8 + mysql2/promise
- Auth: bcryptjs + JWT
- AI: DeepSeek Chat API
- Streaming: SSE + ReadableStream + TextDecoder + AbortController

## 核心功能

1. 注册 / 登录：bcrypt 哈希密码，JWT 登录凭证。
2. 多用户数据隔离：所有周报读写都使用 `req.user.userId` 作为数据边界。
3. AI 流式周报：后端代理 DeepSeek 流，前端实时消费 SSE，不等待完整结果。
4. 停止生成：前端 AbortController 与后端上游 AbortSignal 联动。
5. MySQL 持久化：AI 生成完成后自动保存周报。
6. 历史周报 CRUD：查看、编辑、删除，且全部校验当前用户所有权。
7. 历史上下文增强：生成新周报时可参考最近 3 份历史周报，识别工作连续性，但严格禁止把旧成果写成本周新成果。
8. AI 二次编辑：对历史周报进行“专业化 / 精简 / OKR 化”流式重写，用户确认后再保存数据库。
9. AI 趋势洞察：基于最近 6 份周报分析工作主线、计划承接、反复问题和下周建议。
10. AI 成本保护：按登录用户做轻量限流，避免短时间重复调用模型接口。
11. Token 过期处理：401 时统一清理本地会话并回到登录状态。
12. Markdown 展示、复制、PDF 导出。

## 架构链路

```text
Browser / Vue3
   │
   ├─ register / login ──────────────► Express ─► bcrypt / JWT ─► MySQL users
   │
   ├─ Authorization: Bearer <JWT>
   │            │
   │            ▼
   │      authMiddleware
   │            │
   │      req.user.userId
   │            │
   ├────────────┼────────────────────► MySQL reports (user isolation)
   │            │
   │            └─ AI endpoints ─────► DeepSeek API
   │                                      │
   │                                      ▼
   ◄──────── SSE / ReadableStream ◄──── stream chunks
```

## 本地运行

### 1. MySQL

执行：

```sql
SOURCE server/sql/schema.sql;
```

如果你已经有表，不需要重建；可单独参考 `server/sql/performance.sql` 添加索引。

### 2. 后端

```bash
cd server
npm install
```

复制 `.env.example` 为 `.env`，填写自己的配置。不要把真实 `.env` 上传到 GitHub。

```bash
npm run dev
```

默认：`http://localhost:3001`

### 3. 前端

```bash
cd client
npm install
npm run dev
```

默认：`http://localhost:5173`

Vite 将 `/api` 代理到 `http://localhost:3001`。

## 重点接口

```text
POST   /api/auth/register
POST   /api/auth/login
POST   /api/weekly-report
GET    /api/reports
GET    /api/reports/:id
PUT    /api/reports/:id
DELETE /api/reports/:id
POST   /api/ai/rewrite/:id
POST   /api/ai/insights
GET    /api/health
```

## 面试最值得讲的 6 个点

### 1. 为什么不用一次性返回 AI 文本？
大模型天然逐 token/片段生成。通过 SSE 把上游流直接转发给浏览器，可以降低首字等待时间。前端用 `ReadableStream.getReader()` 消费 chunk，用 `TextDecoder` 解码，再通过 buffer 解决“网络 chunk 边界不等于 SSE event 边界”的问题。

### 2. 为什么需要 buffer？
TCP/HTTP 流不会保证一次 `read()` 恰好得到一条完整 SSE 消息。一次 chunk 可能只包含半条 JSON，也可能包含多条事件，因此先累积到 buffer，再按 `\n\n` 提取完整事件。

### 3. 用户数据怎么隔离？
JWT 解出 `userId` 后写到 `req.user`，所有 `SELECT / UPDATE / DELETE` 都同时带 `id` 与 `user_id` 条件。前端传来的 userId 不被信任，因此无法通过改请求参数读取其他用户的数据。

### 4. 历史上下文为什么不是“硬说自己做了 RAG”？
当前实现是数据库检索最近历史记录后拼接到 Prompt，属于 **history-context augmentation（历史上下文增强）**。它有真实业务价值，但没有 embedding、向量检索与召回排序，所以不应包装成向量 RAG。

### 5. AI 重写为什么不自动覆盖数据库？
AI 输出可能不符合用户预期。系统先流式生成候选稿，在前端预览/编辑，只有用户点击“保存到数据库”才更新原周报，这是 Human-in-the-loop（人在回路）设计。

### 6. 当前限流有什么工程边界？
限流存在 Node 进程内存中，单实例有效；多实例部署时各实例状态不共享。生产环境可以把限流计数迁移到 Redis。这是项目可以继续扩展的工程点，而不是为了堆技术而强行引入 Redis。

## 推荐简历描述

> **AI 智能工作复盘平台｜独立开发**  
> Vue3 + TypeScript + Node.js/Express + MySQL + JWT + DeepSeek API
>
> - 设计 JWT 鉴权与用户数据隔离链路，使用 bcrypt 哈希密码，并以 `req.user.userId` 约束周报 CRUD 权限。
> - 实现 DeepSeek SSE 流式代理，前端基于 ReadableStream / TextDecoder / buffer 解析增量数据，并支持 AbortController 中止生成。
> - 将 AI 生成结果持久化至 MySQL，完成历史周报查询、编辑、删除及 401 会话失效处理。
> - 增加历史上下文增强，在生成周报时检索用户最近 3 份记录辅助识别跨周工作连续性，并通过 Prompt 约束避免历史事实污染。
> - 实现 AI 二次编辑与跨周趋势复盘，对历史周报进行专业化/精简/OKR 重写，并基于最近 6 份周报生成工作主线与计划承接分析。
> - 对 AI 接口增加按用户限流，降低重复请求导致的模型调用成本。

## 后续可继续升级，但不是当前版本必须项

- Redis 分布式限流 / 缓存
- Docker + CI/CD
- 真正的 embedding + vector database RAG
- AI 评测集与 Prompt 回归测试
- 分页 / 搜索 / 统计仪表盘

这些技术应在出现对应业务或工程需求时再加入，不建议为了“技术栈数量”盲目堆叠。

## 工程化附加项

项目还提供了：

- `.github/workflows/ci.yml`：GitHub Actions 自动执行后端测试与前端构建。
- `docker-compose.yml`：可选的一键容器化方案（Vue/Nginx + Express + MySQL）。
- `server/tests/`：使用 Node.js 内置 test runner 做 Prompt 约束回归测试。
- `server/sql/`：数据库建表与索引脚本。

> 注意：Docker / CI 文件已提供，但在你真正跑通 Docker 或把仓库推到 GitHub Actions 验证前，不建议直接在简历上写“熟练使用 Docker / CI/CD”。先跑通再写，项目会更经得住追问。
