# 最终版本学习检查清单

- [ ] 启动Vue/FastAPI/MySQL/Qdrant，确认/api/health返回backend=fastapi。
- [ ] 解释JWT绑定用户与Registry拒绝userId/未知Tool/非法参数。
- [ ] 追踪唯一run_agent的模型→Tool→Tool Result→Loop→Validation。
- [ ] 解释关键词、真实Embedding、Qdrant过滤、SQL hash复核、RRF与CrossEncoder。
- [ ] 解释Candidate不是Evidence，read_report来源/字段/quote及计划状态检查。
- [ ] 演示智能追问、跳过保留不确定、完整草稿与明确确认。
- [ ] 演示安全Trace、刷新恢复、取消、Timeout、Budget与错误终态。
- [ ] 解释requestKey/runId/sessionId、Lease/CAS、三次Retry与确认事务唯一键。
- [ ] 运行Python/Client测试、真实MySQL、多连接并发与真实模型验证。
- [ ] 单命令运行四路Evaluation，读懂Recall/MRR/nDCG/N/A与样本局限。
- [ ] 结合真实代码回答30题，只写已验证能力，不虚构重排提升或零幻觉。

详见AGENT_PROJECT_LEARNING.md。功能与架构冻结后不继续堆框架。
