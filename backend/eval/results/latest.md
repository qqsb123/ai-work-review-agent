# Agent Evaluation — 实际运行结果

生成时间：2026-10-07T15:26:37.412017+00:00
Embedding：intfloat/multilingual-e5-small
Cross-Encoder：cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
Qdrant：真实远程服务；数据：MySQL连接局部临时表。

|路径|Recall@1|Recall@3|Recall@5|MRR|nDCG@5|平均ms|P95ms|降级样本|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|keyword|0.5250|0.7250|0.7250|0.8000|0.6676|1.2|4|0|
|dense|0.7000|0.8750|0.9500|1.0000|0.8824|31.0|34|0|
|rrf|0.7000|0.8750|0.9500|1.0000|0.8745|35.2|47|0|
|rerank|0.6500|0.8250|0.8500|0.9333|0.8005|195.8|304|0|

## Agent指标

- Tool Selection Accuracy: 1.0
- Evidence Valid Rate: 1.0
- Task Success Rate: 1.0
- Unsupported Claim Rate: N/A
- unsupportedClaimReason: 引用来源校验不等于自然语言蕴含。没有人工逐句标注，指标N/A，不伪造零幻觉。
- Average Model Rounds: 4.333333333333333
- Average Tool Calls: 4.333333333333333
- Token Usage: 51856
- Average Latency: 4807.333333333333
- P95 Latency: 8257

## 边界

- 固定小规模合成集，排名指标只平均有正例样本。没有正例的样本指标N/A，另做安全隔离检查。
- 首轮预热与预索引不计入检索延迟；Embedding/Cross-Encoder使用CPU；样本不足以代表线上P95或统计显著提升。
- Agent TaskSuccess基于结构/计划状态/问题数量判据，EvidenceValid为来源检查，不是全部语义结论正确率。
- 跨用户查询仅证明不会返回其他用户记录；本用户可能有语义相关候选，不能要求无关问题必定零召回。
