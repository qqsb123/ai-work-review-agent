# Node → Python 迁移记录

## 当前状态

最终运行入口已切换为backend/FastAPI；Node完整保留在migration_reference/node。Python/Client测试、真实MySQL、真实Qdrant、CrossEncoder、DeepSeek、四路Evaluation与Vue界面已通过。Vue真实/api健康检查返回backend=fastapi，启动、Docker与CI不再使用Express后端。

## 对照策略

冻结Node服务行为后，原server/scripts/export-contract.mjs用合成数据导出backend/tests/node_contract.json，随后才迁移代码。Python test_node_parity.py对照prepare/generate/confirm/insights字段、四类洞察section、source结构和DONE成功结束。41项Python测试覆盖核心旧能力和新RAG权限/降级；真实MySQL脚本验证数据库语义，另用独立前缀表和不同连接真实验证并发事务。测试数量不是等价性的唯一标准。

## 技术栈与映射

- Express Router→FastAPI APIRouter；JWT中间件→Depends鉴权；请求类型→Pydantic严格模型。
- Node Promise/AbortController→asyncio任务、timeout、CancelledError；httpx取消关闭上游连接。
- mysql2参数化SQL→SQLAlchemy Async + aiomysql driver SQL，不为ORM重建业务表。
- DeepSeek原协议→httpx完整completion与严格上游SSE解析；tool_calls/usage/finishReason仍由Runtime检查。
- JS runAgent→app/runtime.py唯一run_agent；任务配置→app/tasks.py与prompts.py。
- Registry→app/tools.py；Evidence→app/evidence.py；Human-in-the-loop→stores.confirm_report。
- Run/Draft/Trace→app/stores.py与lifecycle.py；原表和唯一键保持，旧Node已完成Run可按保存输入等价重放。
- MySQL JSON向量缓存+Node cosine→Qdrant服务、Python真实Embedding、RRF与CrossEncoder；旧report_embeddings表不再作为新检索路径的状态源，不破坏旧数据。

## 数据与密码兼容

保留users/reports主键、bcrypt密码哈希与HS256 JWT。验证原bcryptjs的72字节UTF-8截断行为，Python同样按72字节处理，并支持既有$2a$哈希。token继续userId/username/七天exp；不打印密码、token或密钥。

MySQL只做附加迁移。reports.request_key唯一键继续是正式保存的幂等边界。Python确认新增原子事务，将正式INSERT与saved草稿状态一同提交。

## 验收命令

在backend目录，使用项目虚拟环境：

```powershell
.venv/Scripts/python.exe -m pytest -q
.venv/Scripts/python.exe -m scripts.migrate
.venv/Scripts/python.exe -m scripts.verify_mysql
.venv/Scripts/python.exe -m scripts.verify_parallel
.venv/Scripts/python.exe -m scripts.warm_models
.venv/Scripts/python.exe -m scripts.verify_live
.venv/Scripts/python.exe -m eval.run --live-agent
```

verify_mysql只用MySQL连接局部临时表；verify_parallel用av_随机前缀独立表验证真正不同连接的同时确认，并检查合成requestKey没有进入真实reports，finally只移除本次新建的表，不要求提升账号为全局建库权限。verify_live与eval额外建立随机前缀verification_/evaluation_的Qdrant集合，finally只移除该合成集合，绝不清空业务集合。preview使用临时合成账号和数据验证Vue。

## 切换与回退

Python服务沿用3001，Vue /api和SSE契约不变。通过全部门槛后，启动、Docker和CI只以backend为后端。Node代码可移入migration_reference/node，仅用于参考，不成为生产入口。切换前不删Node；不删除已有MySQL数据或旧索引。未经过线上部署，不能把本地验收写成线上性能保证。


合成预览使用独立随机 JWT 签名密钥，与主应用 token 互不通用；对应隔离测试已通过。
