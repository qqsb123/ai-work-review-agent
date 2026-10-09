# Agent Evaluation：可重复的真实证据

执行：在backend目录运行 `.venv/Scripts/python.exe -m eval.run --live-agent`。不带--live-agent只跑真实检索，Agent指标明确N/A。程序产生eval/results/latest.json、latest.md与带时间戳的JSON；可重复执行，实际模型有随机性。

## 数据与公平比较

固定synthetic-v1包含15份初始合成记录（两个用户），12个检索问题：10个有分级正例，跨用户/过期两个样本没有正例所以排名指标N/A，另检查隔离。评估先为两个租户预索引；删除采购记录并修改前端记录，验证旧向量不能直接成为当前候选。MySQL用连接局部临时表；Qdrant用独立evaluation_集合并在结束清理，不污染真实用户。

A只关键词，B只Qdrant Dense，C关键词+Dense+RRF，D再加真正CrossEncoder。四种路径共用同一模型、语料、标签与Top5，没有用假向量替代。查询前预热/预索引不计入检索延迟。

## 本次实际排名结果

完整数值及逐例IDs、耗时、降级原因在[原始JSON](backend/eval/results/latest.json)与[生成报告](backend/eval/results/latest.md)。有正例样本宏平均Recall@5：Keyword 0.725，Dense 0.950，RRF 0.950，Rerank 0.850。nDCG@5分别约0.6676、0.8824、0.8745、0.8005。四路均没有降级样本。

**真实结论：这组小规模中文样本中，向量召回补足了关键词缺失；当前CrossEncoder未优于Dense/RRF。** 框架已真实参与并不等于每项质量都提升。不能把这次结果改写为“重排准确率提升35%”。

## 指标定义

Recall@K是前K中相关记录数除该query全部相关记录数；MRR是首个相关记录的排名倒数；nDCG@5按0到3分级标签，以(2^grade-1)/log2(rank+1)计算并归一化。没有正例的样本不进入宏平均，明确N/A；不会当作成功率1或召回率0混入。

六个真实DeepSeek样本包含趋势、计划状态、无法确认、充分/模糊输入、注入文本。Tool Selection Accuracy检查必需工具是否使用且没有越出允许集合；Evidence Valid Rate检查最终结构与来源validator通过；Task Success Rate使用预先定义状态/问题数量/结果判据。

最终这次六例均通过工具与证据/任务判据；这不是线上准确率，也不证明零幻觉。Unsupported Claim Rate因没有人工逐句语义蕴含标签显示N/A。Average Rounds、Tool Calls、Token、Average/P95 Latency按真实记录计算。P95使用nearest-rank，六例时实际上接近样本最大值，不能宣传生产SLA。

Token Usage包含DeepSeek usage与本地Embedding/Rerank tokenizer计数，后者是计算量，不是模型账单。缺少上游usage时保守估计并标记，不能把Token总数当精确费用。

## 失败与修复没有被隐藏

开发验收曾出现过度搜索、修订反馈不具体和追问field被当作问题类别。保留硬预算和严格来源门槛，补回具体内部修订反馈、剩余预算提示、field=anchor原文来源规则后重新运行固定样本。此前诊断轮次摘要另记录在eval/results/development_runs.json；最终数据不代表独立留出集，存在对固定样本调试的局限。

## 可写与不能写

可写：实现自研受控Python Agent Runtime；基于真实Qdrant、RRF和CrossEncoder的混合检索；证据追溯与权限隔离；安全Trace、持久化Run、CAS/Checkpoint重跑；人工确认幂等；可重复合成Evaluation。

不能写：所有场景准确率100%、零幻觉、完全防注入、召回全部历史、已完成多实例配额、线上性能SLA、重排必然提升、未测得的提升比例、多Agent自治、LangGraph/MCP/RAG知识图谱等不存在能力。
