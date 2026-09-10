# 项目学习清单

不要从第一行代码硬背。按下面顺序学习，能最快形成面试可讲能力。

## 第一阶段：先把主链路讲通

1. `client/src/components/ReportForm.vue`
2. `client/src/api/weeklyReport.ts`
3. `client/src/api/sse.ts`
4. `server/routes/weeklyReport.js`
5. `server/utils/streamDeepSeek.js`
6. `server/services/deepseek.js`

目标：能白板画出 Vue → fetch → Vite Proxy → Express → DeepSeek → SSE → ReadableStream → Vue 的链路。

## 第二阶段：用户与权限

1. `server/routes/auth.js`
2. `server/middleware/auth.js`
3. `client/src/components/LoginForm.vue`
4. `client/src/api/reports.ts`
5. `server/routes/reports.js`

目标：回答 JWT、Bearer、bcrypt、401、为什么不能信任前端 userId、SQL 数据隔离。

## 第三阶段：AI 应用设计

1. `server/prompts/weeklyReport.js`
2. `server/routes/ai.js`
3. `client/src/api/ai.ts`
4. `client/src/App.vue`

目标：区分普通 Prompt 调用、历史上下文增强、AI 重写、跨周趋势洞察，以及为什么当前不是向量 RAG。

## 第四阶段：工程化

1. `server/middleware/aiRateLimit.js`
2. `.env.example`
3. `server/sql/schema.sql`
4. `server/sql/performance.sql`

目标：理解 API 成本保护、环境变量、索引、单实例内存限流的边界。

## 最低验收用例

- 用户 A 注册并登录，生成周报，数据库 `reports.user_id` 等于 A 的 id。
- 用户 B 登录后看不到 A 的周报。
- A 可以编辑/删除自己的周报，不能访问 B 的周报 id。
- 生成时开启历史上下文，已有历史记录时仍不应把旧成果写成本周完成。
- 历史周报 AI 专业化后，不点击保存则数据库不变；点击保存后才更新。
- 至少 2 份历史周报时可以生成趋势洞察。
- 连续快速调用 AI 接口超过阈值后返回 429。
- Token 失效时前端清理会话并回到登录页。
