# Node 行为参考（非运行入口）

node/保存升级前Express实现、原测试与合成契约导出脚本。未在Python等价验证前删除它；通过验证后才从server迁移到此目录。当前主后端只在backend/，Docker/CI/启动说明都使用FastAPI。

NODE_PROJECT_LEARNING.md、NODE_PROJECT_INTERVIEW.md是历史学习资料。不要把旧JSON向量缓存/Node cosine或旧启动说明当作当前RAG架构。

backend/tests/node_contract.json是冻结Node合成行为的golden输出；test_node_parity.py对照关键协议。参考代码保留用于学习与回退，不在生产启动链路中执行。
