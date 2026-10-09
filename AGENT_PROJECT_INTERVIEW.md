# 30道最终 Python 代码面试题

本题集对应 backend/app 的真实实现；Node 只作为迁移对照。回答应结合 AGENT_PROJECT_LEARNING.md 与实际 Evaluation，不背不存在的框架能力。

1. **这个项目解决什么问题？** 从模糊工作输入到可确认周报，再用历史原文复盘连续性与计划。重点是事实、证据、权限与确认闭环；AI分析不自动改正式数据。
2. **为什么迁移FastAPI？** 复用Python的Embedding/CrossEncoder生态，保留原契约与自研Runtime。迁移价值在工程与生态，不声称换语言使模型自动更聪明。
3. **如何证明迁移没有缩水？** 冻结Node合成契约导出golden JSON，Python逐项对照关键接口字段/SSE/来源结构，再用单位、真实SQL、真实模型、Vue操作和评估补足。
4. **为何不直接用ORM重建表？** 原SQL唯一键与事务语义已经清楚，Database用SQLAlchemy Async driver SQL保留结构。ORM不是本次目标，减少迁移风险。
5. **JWT身份在哪里绑定？** main.py的Depends验证HS256和exp，得到userId；模型Schema禁止userId，SQL和Qdrant过滤都用服务端上下文。
6. **旧bcrypt密码能继续登录吗？** 支持原哈希，包括$2a$，保留bcryptjs UTF-8 72字节截断规则。密码只参与哈希/比较，不进Trace或模型。
7. **Pydantic为何还不能代替Registry校验？** HTTP输入和模型tool_calls是不同信任边界。Registry仍检查白名单、必填、多余字段、类型、长度和范围。
8. **什么才是Agent Loop？** 模型返回tool_calls，应用执行受控工具并role:tool回传，再由模型决定下一步，直到结构与证据校验通过。一次文本生成不是这个Loop。
9. **三个Agent是不是多Agent？** 是任务配置共用唯一run_agent；没有自治协作、独立调度或另一个执行器。insights/plans/clarification只改变规则、上下文和validator。
10. **为什么完整assistant消息要保留？** Tool Calling协议需要完整回传关联调用，可能有reasoning字段；它只留本次内存，不进Trace/Checkpoint，不发前端。
11. **怎么拒绝模型伪造SQL工具？** Registry只在entries白名单找到工具后执行。execute_sql、额外userId或错误参数返回受控输入错误，绝不执行任意表达式。
12. **Budget怎么控制？** 8轮、12工具、上下文/Token/修订/时间都有硬限制；缺usage用UTF-8保守预留；工具结果只提示剩余预算，超限仍服务端终止。
13. **Hybrid RAG与旧历史上下文有什么区别？** 新路径有真实Embedding和Qdrant Dense服务，再与关键词融合和CrossEncoder排序。旧最近记录拼Prompt不能被称为这个能力。
14. **为什么需要RRF？** 关键词与向量分数不在同一尺度，排名倒数融合不用直接相加原始分值。实际是否更好由固定样本评估决定。
15. **CrossEncoder与Embedding有何不同？** Embedding可预计算文档向量；CrossEncoder把query和document联合编码给相关性分数，只对少量融合候选计算，再Top-K。
16. **Qdrant存什么？** 向量、userId/reportId/contentHash/modelVersion；pointId由服务端UUID5生成。MySQL仍保存权威正文与正式业务。
17. **向量如何隔离用户？** Qdrant查询must过滤userId与模型版本，结果再按MySQL当前user_id校验；read_report还会再次校验reportId+userId。
18. **报告编辑或删除后怎么办？** 业务接口尽力删除旧point；每次候选回到SQL核对存在性和hash，所以索引更新失败也不能采用旧正文或已删除记录。
19. **RAG候选为何不是Evidence？** 候选只是相关性摘要，可能截断或失效。不填sources，只有read_report实际返回字段才具备引用资格。
20. **Evidence检查证明什么？** 证明来自本次合法读取的连续原文，字段与数量符合规则。它不证明所有自然语言推论都正确，所以Unsupported Claim Rate不能假装为零。
21. **计划完成为什么不能引用原计划？** 原计划只证明意图。确定状态必须有后续同一事项明确事实，且经过find_plan_evidence集合、read_report、先后关系和状态词校验。
22. **Prompt Injection怎么处理？** 历史与候选始终是tool数据，不升级为system；即使模型受诱导，白名单和用户范围仍约束执行。不能宣传彻底消除所有语义注入。
23. **Trace怎样兼顾可解释和隐私？** 记录阶段、工具名、文本长度、数量/ID、耗时、用量、预算和错误码，不记录正文、query全文、私有推理、密码或请求头。
24. **SSE为什么要result与DONE都收到？** result是经过校验的候选最终结果，DONE才是完整成功结束。断流即使见过result也不采用；trace和progress更不能当成功。
25. **取消怎样传播？** 浏览器Abort关闭流，StreamingResponse取消worker，asyncio取消httpx/Qdrant等待。已开始的CPU线程结果丢弃，闸门保持到线程结束，不伪称强制杀线程。
26. **Checkpoint为什么不保存全部消息？** 本项目选择安全重跑：保存边界、stats、sourceIds和原始输入，重新读取事实，避免续接旧证据、半个工具协议或私有推理。
27. **requestKey/runId/sessionId分别是什么？** 请求幂等身份、任务执行身份、待确认草稿身份。成功requestKey重放结果；sessionId还成为正式reports唯一保存键。
28. **Lease/CAS和重试怎么工作？** running持有四分钟leaseToken，失败或到期显式重抢，attempt最多三次。条件写入拒绝旧Token完成或覆盖新尝试。
29. **为什么HITL仍然必要？** 生成与分析可以误判，正式INSERT需要明确confirm与正文一致性。事务结合唯一键和saved草稿更新，并发/断线重试只保存一份。
30. **怎样证明优化有效且不造数字？** 同一固定合成集真实比较Keyword/Dense/RRF/Rerank，输出Recall/MRR/nDCG和六例Agent指标；无标签显示N/A。此次重排序不优于Dense，不能写成统一准确率提升或线上SLA。
