# AGENT_PROJECT_LEARNING：最终 Python 版本

主实现位于 backend/app，使用 FastAPI。前端仍为 Vue3 + TypeScript。Node 行为基准只用于迁移对照，旧学习资料归档于 migration_reference，不代表主后端。最终验收状态见 AGENT_ACCEPTANCE.md。

## 先分清谁决定什么

模型决定是否检索、选哪个白名单工具、怎样组织有依据的结论。FastAPI 决定身份、输入有效性、任务生命周期、预算、取消、保存权限和 HTTP/SSE 协议。Registry 决定哪些函数可以执行、参数是否合法。MySQL 保存权威业务数据与 Run/Draft 状态。Qdrant 保存向量和检索元数据。CrossEncoder 对已召回候选排序，不能创造事实。Evidence 只认可本次 read_report 实际返回的字段。

## 三条业务链路

1. 周报：输入→0到3个追问→补充/跳过→同一 sessionId→完整模型流→事实检查/保守回退→MySQL ready 草稿→人工确认→唯一键幂等正式保存。
2. 趋势：按需检索→Qdrant/关键词/RRF/重排候选→read_report 至少两份→模型 JSON→Evidence Validation→持久化结果→result+DONE→Vue 引用查看。
3. 计划：get_recent_plans→每项 find_plan_evidence→read_report 后续正文→明确同一事项状态→校验→只读建议。没有提到不等于未完成，原计划不能证明完成。

三类任务只有一套 run_agent，不是自治多 Agent。普通周报润色和重写也不包装成 Agent Loop。

## 推荐学习顺序

1. 先启动 Vue/FastAPI/MySQL，读通表单、登录、历史与确认保存。
2. 阅读 models.py、main.py 的 Dependency、APIRouter，理解前端字段与后端契约。
3. 阅读 tools.py：Schema 是第二道校验，userId 不来自模型。
4. 阅读 runtime.py：按一次搜索、两次读取、一次结果追踪完整 Loop。
5. 阅读 evidence.py：先验证来源，再区分引用存在和推论正确。
6. 阅读 stores.py：requestKey/runId/sessionId、CAS Lease、事务与唯一键。
7. 阅读 lifecycle.py/provider.py：StreamingResponse、取消、超时、result/DONE。
8. 阅读 retrieval.py：真实 Embedding、Qdrant 服务过滤、当前 SQL/hash 复核、RRF 与 CrossEncoder。
9. 阅读 eval/dataset.py、metrics.py、run.py：先理解固定标签，再执行四路比较和真实 Agent 评估。
10. 阅读 tests 与 Node golden contract，复现权限、断流、降级、重试和并发确认。
11. 最后结合架构文档与实际评估，准备面试；冻结后只修缺陷、性能、测试与学习。

## 关键文件：职责、依赖和调用关系

### app/main.py

FastAPI 组装入口，APIRouter 定义 auth/reports/weekly/ai/runs API，Depends 验证 JWT。调用 Database、RunStore/DraftStore、run_task、stream_response 与确认事务。被 Uvicorn 和 create_app 测试工厂调用。面试点：为什么前端传 userId 不可信？为什么路由只选择任务配置，不复制 Runtime？

### app/models.py / config.py / errors.py

Pydantic strict 请求模型、周报归一化、服务端配置和稳定错误码。配置读取 backend/.env，凭证不进入模型参数。被路由、provider、检索与脚本调用。面试点：为什么 forbid extra 与 strict type 都需要？为什么不能原样暴露数据库或上游异常？

### app/db.py

SQLAlchemy Async + aiomysql 参数化 driver SQL，保留既有 SQL/索引语义而不引入实体重构。每次正式 transaction 使用 engine.begin；测试临时表固定同一连接并串行操作。hide_parameters 避免异常输出 SQL 参数。被可信业务接口、Store 与 Tool 调用。面试点：为什么确认要把 INSERT 与 saved 状态放进同一事务？

### app/provider.py

httpx 调用 DeepSeek 原生兼容协议，明确传 tools/tool_choice、max_tokens、stream、usage 与 finishReason。完整 assistant 仅在内存回传；对浏览器只发内容和安全事件。流必须同时有 stop 与上游 DONE。被 Runtime 和生成/重写调用。面试点：为什么上游 length 不能当成功？asyncio cancel 怎样关闭 HTTP？

### app/tasks.py / prompts.py

insights/plans/clarification 的系统规则、用户输入、工具与 validator 配置。只调用同一个 run_agent。追问的 field 表示 anchor 原文来源，不能因问题类别而指向空 problems/nextPlan。模型可修订，但不能补造事实。面试点：任务配置复用为何不等于多 Agent 协作？

### app/runtime.py

唯一执行循环：8轮、12工具、每轮6工具、每轮3000输出 Token、累计80000、50000上下文字符、两次最终修订、180秒。检查完整 finishReason、唯一 callId、协议一致性；保留完整 assistant→role:tool→下一轮。缺 usage 保守估计；检索计算用量合并预算。工具结果附服务端剩余预算，模型仍需服从硬限制。被 tasks 调用，依赖 Registry、complete、validator、emit 的注入。面试点：预算提示为什么不能替代强制终止？

### app/tools.py

Registry 的唯一白名单、JSON Schema 与本地类型/长度/范围校验。未知工具、多余 userId、非法 JSON、bool冒充int 均拒绝。工具得到 JWT 绑定的 ctx.userId。search_reports 返回摘要，read_report 按 id+user_id读取并填 sources，hybrid_search_reports 仅返回候选。计划工具保持原计划、后续检索集合和时间关系。被 Runtime 调用；只查询正式报告，不暴露 confirm_report 给模型。面试点：模型请求能力和服务端执行权限如何分开？

### app/evidence.py

check_evidence 校验真实读取来源、字段白名单、6到400字连续原文；空白可规范化。insights 要求两份原文和跨记录引用；plans要求已读取计划、无关键词后续检索、实际后续来源、同一事项明确状态。validate_clarification 要求问题 anchor 来自声明字段。被 Runtime 最终校验调用。面试点：引用存在为何不能证明全部语义推论正确？

### app/retrieval.py

LocalModels 真正加载 SentenceTransformer/CrossEncoder；Qdrant 使用 AsyncQdrantClient 访问服务，非本地 fake 或 NumPy 替身。关键词与 Dense 分别召回，RRF(k=60)融合，最多20候选做 query-document CrossEncoder 重排，再 Top-K。

VectorIndex 的 UUID5按 collection/user/report生成；payload包含userId/reportId/contentHash/modelVersion。must过滤服务端用户与模型版本；所有向量候选回到 MySQL复核所有权、删除和当前hash，不把 payload 当证据。在线每 Run最多补索引12份近期记录，预索引命令处理最多最近200份。

Embedding故障→Keyword，Qdrant故障→Keyword，Reranker故障→RRF；原因和数量、各阶段耗时写Trace。取消向下游传播；CPU库已开始的线程不能强制杀掉，迟到结果丢弃，推理闸门保留到线程结束，避免无界并发。被RAG Tool、预索引与Eval调用。面试点：CrossEncoder为何放在融合后？

### app/stores.py

RunStore保留UNIQUE(user_id,request_key)、输入等价比对、runId、attempt、240秒lease、CAS token、Checkpoint与结果。成功键重放，失败显式retry，最多三次，旧token不能完成新run。

DraftStore七天TTL，create/get/claim/save均绑定所有权，generationToken拒绝旧生成的迟到写入。confirm_report仅可信明确确认入口使用，核对ready和正文一致性，事务内做reports唯一键INSERT、正文复核和saved更新。被路由/任务生命周期调用。面试点：为什么sessionId和requestKey不能混为一个业务身份？

### app/lifecycle.py

用户级并发、进程内限流、Queue→StreamingResponse、15秒心跳、有序安全Trace、断线取消和持久化终态。Trace不保存全文、query、Authorization、API key、密码或reasoning。Checkpoint只有boundary/stats/sourceIds/recovery，不保存推理；重试重新读当前原文。被 main 调用。面试点：为什么先存成功结果再发result/DONE？

### app/weekly.py

同一草稿追加补充事实、保留未回答问题，拦截未提供数字和部分不确定完成表述。失败时按原输入保守整理，不追加模型收费，不自动保存正式报告。被生成路由调用。面试点：为什么事实回退不能替代人工确认？

### client/src/api/sse.ts / agentRuns.ts

保留POST fetch鉴权、TextDecoder和空行分块，处理progress/trace/result/DONE。Trace不会满足requireResult；断流结果不算成功。agentRuns读取已保存轨迹、恢复结果与安全重跑。调用FastAPI同一/api契约。面试点：字节块为何不等于SSE事件？

### client/src/components/AgentTrace.vue / ReportForm.vue / PlanTracker.vue / App.vue

分别展示任务列表与结构化执行详情、追问与续接、计划建议与证据、整体生成确认和恢复。异步恢复核对账号与当前请求，卸载取消。恢复的ready草稿仍需确认。面试点：UI loading、prepared、ready、saved为何分开？

### eval/dataset.py / metrics.py / run.py

固定合成文档和相关性标签，覆盖关键词、同义词、无共同关键词、趋势、计划、无法确认、干扰、注入、跨用户和过期记录。四路实跑A Keyword/B Dense/C RRF/D Rerank，输出Recall@1/3/5、MRR、nDCG@5、延迟；无正例显示N/A。六个真实DeepSeek Agent样本记录工具选择、来源有效、任务判据、轮次、调用、用量和延迟。

Unsupported Claim Rate缺逐句蕴含人工标签时是N/A，不能用Evidence Valid Rate冒充零幻觉。数据在MySQL连接局部临时表和随机Qdrant测试集合，关闭/结束后只清理合成数据。被单条python -m eval.run --live-agent调用。面试点：如何避免拿“框架存在”当检索质量提升？

### scripts / tests

migrate附加迁移；index_reports显式用户预索引；warm_models真实加载并预测；verify_mysql验证真实SQL/事务/幂等/HTTP；verify_parallel通过独立前缀表验证真实多连接并发确认，并检查没有写入真实业务表；verify_live验证真实模型、向量、重排、三个Agent和旧生成重写；preview验证Vue实际接口。

tests/node_contract.json来自冻结Node合成行为，test_node_parity对照接口。其他测试覆盖权限、假引用、字段错误、断流、Budget、取消、超时、降级、Lease、Retry和并发确认。测试能力对应比单纯比较测试数量更重要。

## 学习完成标准与边界

能解释模型选择、Registry权限、MySQL权威、Qdrant候选、RRF尺度、CrossEncoder联合编码、Evidence来源、Checkpoint安全重跑和HITL正式写入，并能复现真实评估。

本项目仍有有限历史窗口、无周报周期/版本字段、进程内并发配额、保守状态判断、CPU推理与小样本评估局限。实际重排序可能不优于Dense/RRF；评估不会伪造提升比例。30道代码面试题见 AGENT_PROJECT_INTERVIEW.md。
