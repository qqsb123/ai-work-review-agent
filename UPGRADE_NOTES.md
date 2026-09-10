# 本次升级内容

这版以“简历含金量 + 面试可讲性 + 业务完整度”为目标，不追求无意义堆技术。

## 新增

- 历史上下文增强生成：最近 3 份周报参与 Prompt，但加入事实边界约束。
- AI 二次编辑：专业化 / 精简 / OKR 化，SSE 流式输出，确认后再保存。
- AI 工作趋势洞察：最近 6 份周报生成跨周复盘。
- 统一前端 SSE 客户端：抽离 `streamPost`，复用流解析、401 与 AbortController 逻辑。
- 统一后端 DeepSeek SSE 转发工具：减少重复流解析代码。
- AI 用户级限流：单实例内存限流，保护 API 成本，并明确 Redis 扩展边界。
- SQL schema + 索引脚本。
- Node 内置测试：Prompt 事实约束回归测试。
- GitHub Actions CI 配置。
- 可选 Docker Compose：Nginx + Vue、Express、MySQL。
- 完整 README 与学习清单。

## 保留

- 注册 / 登录
- bcrypt + JWT
- MySQL 用户数据隔离
- 历史周报 CRUD
- SSE 流式生成
- AbortController 停止生成
- Markdown / 复制 / PDF
- Token 过期处理

## 不伪装成 RAG

当前“历史上下文增强”是 MySQL 最近记录检索 + Prompt 增强，不包含 embedding、向量数据库和向量召回，因此 README 明确不把它包装成向量 RAG。这样更经得住面试追问。
