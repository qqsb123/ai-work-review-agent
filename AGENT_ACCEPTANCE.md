# 最终 Python / Qdrant / Reranker 验收

验收跨度：2026-10-07至2026-10-09；最终核对：2026-10-09（Asia/Shanghai）。功能与架构冻结，后续只修缺陷、性能、测试与学习。生产入口只使用backend/FastAPI，Node保留于migration_reference/node，未在Python等价验证前删除。

## 已通过

- Python 41项单元/安全/契约/可靠性/指标测试；Client 7项协议测试；TypeScript与生产构建通过。原Node golden对照prepare/generate/confirm/insights字段、source结构与DONE。
- 真实MySQL：附加迁移、登录注册、用户隔离、持久化Draft/Run、Retry attempt、Checkpoint、旧lease拒绝、成功重放、确认幂等与HTTP接口。
- 真实不同连接并发确认：两次同时请求在同一唯一键与事务边界下只保存一份，返回同一reportId；使用随机av_前缀独立表，并检查合成requestKey未进入真实reports，结束清理测试表。未提升数据库账号权限。
- 真实Qdrant Windows服务v1.18.3参与Dense检索，payload包含userId/reportId/contentHash/modelVersion。测试两个用户的向量均已入库，服务端过滤和SQL复核排除跨用户/删除记录。
- 真实Embedding intfloat/multilingual-e5-small，固定revision，384维。权重SHA256与官方LFS指针一致：1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477。
- 真实CrossEncoder cross-encoder/mmarco-mMiniLMv2-L12-H384-v1已加载与predict；权重SHA256为1abc209e54d70bbcb08c1b5111a924fb99c0428f51cab1659310ccdcab69dc03，与下载源LFS指针一致。网络受限时经镜像下载标准权重/分词器，本地加载禁用远程自定义代码。
- 真实DeepSeek验证趋势、计划、充分输入追问、周报生成与重写流，结果完整结束并持久化安全Trace；没有写真实用户周报。
- Vue实际连接FastAPI：合成登录/历史、真实Qdrant与CrossEncoder轨迹、原文依据、刷新读取Run、恢复结果、完整草稿、明确确认与取消中断。确认前历史14份，确认后15份，仅为临时表合成记录。
- 真实取消操作显示已停止分析，不收到成功结果；刷新任务列表显示已中断。截图docs/images/python-rag-trace.png包含真实vectorCount/rerankCount/fallback与中断任务。
- 最终Vue5173的/api代理健康检查返回backend=fastapi；后端启动入口3001为Uvicorn/FastAPI。Docker/CI路径已切换，配置语法检查通过。

## 实际Evaluation

12个检索问题，10个有分级正例，四路均真实运行且无降级样本。Recall@5：Keyword 0.725、Dense 0.950、RRF 0.950、Rerank 0.850；nDCG@5约0.6676、0.8824、0.8745、0.8005。当前重排序未优于Dense/RRF，不能虚构提高百分比。

最后这次六例真实Agent：Tool Selection、Evidence Valid、Task Success均6/6；平均轮次4.333、平均工具4.333、总Token51856、平均延迟4807.3ms、样本P95 8257ms。Token含本地模型tokenizer计算量；小样本P95不是线上SLA。Unsupported Claim Rate没有逐句人工语义标签，为N/A，不宣称零幻觉。

前两轮开发评估出现3/6、4/6任务通过，保留摘要，修复后重新评估；最终固定集合参与过调试，不是独立留出集。完整逐例结果见backend/eval/results/latest.json、latest.md与development_runs.json。

## 未声称完成的事项与边界

没有Docker主机，因此未构建/运行Docker镜像；没有线上部署、提交或推送。没有跨实例配额、全量历史召回、周报周期/版本治理、正式计划状态管理或自动提醒。Evidence是来源校验，不是所有语义结论证明。CPU线程不能强制中断，取消丢弃迟到结果并保留闸门。

Run/Trace/向量缓存需保留策略；草稿七天过期；重跑重新读取事实，最多三次，不是模型推理逐条续跑。前端仍有较大bundle提示、localStorage JWT和截图式PDF局限。

## 最终交付索引

1. 最终目录结构：[README](README.md)。主backend、client、eval、tests及Node迁移参考已分清。
2. 最终系统架构图：[架构文档](AGENT_PROJECT_ARCHITECTURE.md)，包含完整Mermaid与旁路。
3. 完整请求数据流：架构文档的十二步，从JWT/requestKey到Evidence/result/DONE与明确确认。
4. Node→Python说明：[迁移文档](PYTHON_MIGRATION.md)，golden对照、保留旧代码后切换。
5. Python技术栈：README，FastAPI/Pydantic/asyncio/httpx/SQLAlchemy Async/aiomysql/PyJWT/bcrypt。
6. RAG数据流：关键词+Qdrant Dense→RRF→CrossEncoder→候选→read_report。
7. Qdrant数据结构：架构文档payload和UUID5，userId/reportId/contentHash/modelVersion与服务过滤。
8. Reranker工作方式：融合后的query-document联合编码，最多20候选重排，有真实predict记录。
9. Agent Runtime工作方式：[学习文档](AGENT_PROJECT_LEARNING.md)，单一循环、工具、预算与最终校验。
10. Trace结构：安全type/stage/runId/attempt/seq/timestamp/meta；没有私有推理、完整query或正文。
11. Checkpoint/Retry：安全边界+stats，四分钟Lease/CAS，最多三次从原始输入重跑。
12. Evidence Grounding：真实读取白名单、字段与连续quote、跨记录和计划后续事实校验。
13. Human-in-the-loop：持久化ready不等于正式报告；confirm=true和正文一致才事务内幂等保存。
14. 全部测试结果：本记录与backend/tests、verify_mysql、verify_parallel、verify_live及client/tests。
15. Evaluation真实结果：[评估说明](AGENT_EVALUATION.md)与[原始JSON](backend/eval/results/latest.json)。
16. 当前限制：README与本记录，有限索引窗口、进程内配额、CPU取消、语义和小样本局限。
17. 可写简历能力：真实Runtime/Tool/RAG/Qdrant/Rerank/Evidence/Trace/Run/HITL/Eval。
18. 不能写能力：零幻觉、通用100%准确、线上SLA、虚构提升、多Agent/MCP/LangGraph等未实现内容。
19. 学习顺序：学习文档十一阶段，先业务再Loop/权限/数据/评估。
20. 30道真实代码面试题：[面试文档](AGENT_PROJECT_INTERVIEW.md)。

2026-10-09重启后补充核对：41项Python测试再次通过；补齐PyMySQL RSA认证依赖后，真实MySQL及不同连接并发确认再次通过；已清理中断遗留的合成预览集合。应用进程仅为本机服务补充NO_PROXY，不改变系统代理或远程模型代理配置。
