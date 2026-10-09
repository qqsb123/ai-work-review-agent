import argparse
import asyncio
import json
import statistics
import time
import uuid
from datetime import datetime,timezone
from pathlib import Path
from app.config import settings,ROOT
from app.retrieval import HybridRetrieval,LocalModels,VectorIndex,content_hash,text_of
from app.provider import DeepSeek
from app.tasks import run_task
from app.runtime import Limits
from scripts.fixtures import temporary_db,insert_records
from .dataset import records,CASES,AGENT_CASES
from .metrics import retrieval_metrics,average_metrics,p95

async def evaluate(live_agent=False):
    model=LocalModels();await model.compute(model.load)
    collection='evaluation_'+uuid.uuid4().hex
    index=VectorIndex(model_version=model.version,collection=collection)
    result={'datasetVersion':'synthetic-v1','generatedAt':datetime.now(timezone.utc).isoformat(),'embeddingModel':settings.embedding_model,
        'rerankerModel':settings.reranker_model,'qdrantMode':'remote-server','realUserDataWritten':False,'retrieval':{},'agent':{},'limitations':[]}
    try:
        async with temporary_db() as db:
            corpus=records();await insert_records(db,corpus)
            # Preindex both synthetic tenants. Search isolation must be proved
            # by Qdrant filtering, not by only storing one user's data.
            for user in (7,8):
                owned=[row for row in corpus if row['user_id']==user]
                vectors,_=await model.embed([text_of(r) for r in owned]);await index.upsert(user,owned,vectors)
            # Old point survives intentionally: SQL hash/deletion gate must block it.
            await db.execute('DELETE FROM reports WHERE id=? AND user_id=?',(7,7))
            await db.execute('DELETE FROM reports WHERE id=? AND user_id=?',(6,7))
            # Restore document6 to a changed text for stale test; relevance of the
            # distractor case remains an existing record with a fresh vector.
            edited={**corpus[5],'content':'前端首屏优化已完成，图片按需加载降低渲染等待。'}
            await insert_records(db,[edited]);vec,_=await model.embed([text_of(edited)]);await index.upsert(7,[edited],vec)
            rag=HybridRetrieval(db,model,index)
            for mode in ('keyword','dense','rrf','rerank'):
                rows=[]
                for case in CASES:
                    started=time.monotonic();value=await rag.search(case['query'],{'userId':7,'sources':{}},5,mode=mode)
                    ids=[r['id'] for r in value['reports']]
                    safe=11 not in ids and (not case.get('mutation') or 7 not in ids)
                    if not safe:raise AssertionError('TENANT_OR_STALE_LEAK')
                    rows.append({'caseId':case['id'],'category':case['category'],'rankedIds':ids,'metrics':retrieval_metrics(ids,case['relevance']),
                        'latencyMs':round((time.monotonic()-started)*1000),'trace':value['retrieval'],'isolationPassed':safe})
                result['retrieval'][mode]={'metrics':average_metrics([r['metrics'] for r in rows]),'cases':rows,
                    'averageLatencyMs':statistics.mean(r['latencyMs'] for r in rows),'p95LatencyMs':p95([r['latencyMs'] for r in rows]),
                    'fallbackCaseCount':sum(bool(r['trace']['fallbackReasons']) for r in rows)}
            if live_agent:
                provider=DeepSeek();agent_rows=[]
                try:
                    for case in AGENT_CASES:
                        events=[];started=time.monotonic();output=None;metrics={};failure=None
                        async def emit(event):events.append(event)
                        try:output,metrics=await run_task(case['task'],case['input'],7,db,provider,rag,emit)
                        except Exception as error:failure=getattr(error,'code','AGENT_FAILED')
                        selected=[e['meta']['tool'] for e in events if e.get('stage')=='tool_end' and e.get('meta',{}).get('tool')]
                        correct=set(case['required'])<=set(selected)<=set(case['allowed'])
                        success=output is not None
                        if success and 'expectedStatus' in case:success=all(p['status']==case['expectedStatus'] for p in output['plans'])
                        if success and 'expectedQuestions' in case:success=len(output['questions'])==case['expectedQuestions']
                        if success and 'minQuestions' in case:success=len(output['questions'])>=case['minQuestions']
                        valid=output is not None and any(e.get('stage')=='validation_passed' for e in events)
                        agent_rows.append({'caseId':case['id'],'task':case['task'],'tools':selected,'toolSelectionCorrect':correct,'evidenceValid':valid,'taskSuccess':success,
                            'metrics':metrics,'latencyMs':round((time.monotonic()-started)*1000),'failureCode':failure})
                finally:await provider.close()
                n=len(agent_rows);completed=[r for r in agent_rows if r['metrics']]
                result['agent']={'cases':agent_rows,'Tool Selection Accuracy':sum(r['toolSelectionCorrect'] for r in agent_rows)/n,
                    'Evidence Valid Rate':sum(r['evidenceValid'] for r in agent_rows)/n,'Task Success Rate':sum(r['taskSuccess'] for r in agent_rows)/n,
                    'Unsupported Claim Rate':None,'unsupportedClaimReason':'引用来源校验不等于自然语言蕴含。没有人工逐句标注，指标N/A，不伪造零幻觉。',
                    'Average Model Rounds':statistics.mean(r['metrics']['steps'] for r in completed) if completed else None,
                    'Average Tool Calls':statistics.mean(r['metrics']['toolCalls'] for r in completed) if completed else None,
                    'Token Usage':sum(r['metrics'].get('totalTokens',0) for r in completed),
                    'Average Latency':statistics.mean(r['latencyMs'] for r in agent_rows),'P95 Latency':p95([r['latencyMs'] for r in agent_rows])}
            else:result['agent']={'status':'N/A','reason':'未启用--live-agent；不把测试模型计为真实Agent评估'}
            result['limitations']=['固定小规模合成集，排名指标只平均有正例样本。没有正例的样本指标N/A，另做安全隔离检查。',
                '首轮预热与预索引不计入检索延迟；Embedding/Cross-Encoder使用CPU；样本不足以代表线上P95或统计显著提升。',
                'Agent TaskSuccess基于结构/计划状态/问题数量判据，EvidenceValid为来源检查，不是全部语义结论正确率。',
                '跨用户查询仅证明不会返回其他用户记录；本用户可能有语义相关候选，不能要求无关问题必定零召回。']
            return result
    finally:
        # Only this freshly generated synthetic collection is ever removed.
        if collection.startswith('evaluation_') and await index.client.collection_exists(collection):await index.client.delete_collection(collection)
        await index.close()

def markdown(result):
    lines=['# Agent Evaluation — 实际运行结果','',f"生成时间：{result['generatedAt']}",f"Embedding：{result['embeddingModel']}",f"Cross-Encoder：{result['rerankerModel']}",'Qdrant：真实远程服务；数据：MySQL连接局部临时表。','',
        '|路径|Recall@1|Recall@3|Recall@5|MRR|nDCG@5|平均ms|P95ms|降级样本|','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for mode,row in result['retrieval'].items():
        fmt=lambda x:'N/A' if x is None else f'{x:.4f}'
        lines.append('|'+mode+'|'+'|'.join(fmt(row['metrics'][key]) for key in ('Recall@1','Recall@3','Recall@5','MRR','nDCG@5'))+f"|{row['averageLatencyMs']:.1f}|{row['p95LatencyMs']}|{row['fallbackCaseCount']}|")
    lines.extend(['','## Agent指标',''])
    for key,value in result['agent'].items():
        if key!='cases':lines.append(f'- {key}: {"N/A" if value is None else value}')
    lines.extend(['','## 边界','',*['- '+text for text in result['limitations']]])
    return '\n'.join(lines)+'\n'

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--live-agent',action='store_true');args=parser.parse_args()
    result=await evaluate(args.live_agent)
    output=ROOT/'eval'/'results';output.mkdir(parents=True,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    (output/f'run-{stamp}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (output/'latest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (output/'latest.md').write_text(markdown(result),encoding='utf-8')
    print(json.dumps({'retrieval':{k:v['metrics'] for k,v in result['retrieval'].items()},'agent':{k:v for k,v in result['agent'].items() if k!='cases'}},ensure_ascii=False,indent=2))

if __name__=='__main__':asyncio.run(main())
