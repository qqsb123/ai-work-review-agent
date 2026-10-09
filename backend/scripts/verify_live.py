import asyncio
import json
import uuid
import httpx
from app.main import create_app
from app.provider import DeepSeek
from app.retrieval import HybridRetrieval,LocalModels,VectorIndex,text_of
from app.tasks import run_task
from app.stores import RunStore
from app.runtime import Limits
from tests.helpers import RECORDS,noop
from tests.test_contract import events,token
from .fixtures import temporary_db,insert_records

async def verify():
    models=LocalModels();await models.compute(models.load)
    index=VectorIndex(model_version=models.version,collection='verification_'+uuid.uuid4().hex)
    provider=DeepSeek();results=[]
    try:
        async with temporary_db() as db:
            await insert_records(db,RECORDS)
            for user in (7,8):
                rows=[r for r in RECORDS if r['user_id']==user]
                vectors,_=await models.embed([text_of(r) for r in rows]);await index.upsert(user,rows,vectors)
            rag=HybridRetrieval(db,models,index)
            # Real server owner filtering, not a local/mock client.
            vector,_=await models.embed(['秘密登录项目'],query=True)
            points=await index.search(7,vector[0]);assert all(p.payload['userId']==7 for p in points)
            app=create_app(db,provider,rag)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test',timeout=200) as client:
                for task,input in [('insights',{'question':'请用hybrid_search_reports搜索身份验证与访问控制候选，再读取两份原文复盘推进情况。'}),
                    ('plans',{'reportId':1}),('clarification',{'work':'登录模块本周已完成开发和自测，解决了会话恢复缺失，当前没有阻塞。','problems':'会话恢复缺失已修复。','nextPlan':'下周进行权限联调。','style':'detailed','useHistory':False})]:
                    endpoint='/api/weekly-report/prepare' if task=='clarification' else '/api/ai/'+task
                    response=await client.post(endpoint,headers=token(),json={**input,'requestKey':str(uuid.uuid4())})
                    assert response.text.endswith('data: [DONE]\n\n'),response.text[-300:]
                    output=next(e['result'] for e in events(response.text) if e['type']=='result')
                    saved=await RunStore(db).get(output['runId'],7)
                    assert saved['status']=='succeeded'
                    assert 'reasoning_content' not in json.dumps(saved['events'])
                    if task=='insights':
                        retrieval_events=[e['meta']['result']['retrieval'] for e in saved['events'] if e.get('stage')=='tool_end' and e.get('meta',{}).get('tool')=='hybrid_search_reports']
                        assert retrieval_events and any(e['vectorCount']>0 and e['rerankCount']>0 and not e['fallbackReasons'] for e in retrieval_events)
                    if task=='plans':assert output['plans'][0]['status']=='in_progress'
                    if task=='clarification':
                        assert output['questions']==[]
                        generated=await client.post('/api/weekly-report',headers=token(),json={'sessionId':output['sessionId'],'skipClarification':True,'answers':[]})
                        assert generated.text.endswith('data: [DONE]\n\n')
                    results.append({'task':task,'metrics':output['metrics'],'traceEvents':len(saved['events'])})
                rewritten=await client.post('/api/ai/rewrite/1',headers=token(),json={'mode':'concise'})
                assert rewritten.text.endswith('data: [DONE]\n\n')
            return {'verified':True,'realMySQL':True,'realQdrant':True,'realEmbedding':True,'realCrossEncoder':True,'realDeepSeek':True,'tasks':results,'realUserDataWritten':False}
    finally:
        if index.collection.startswith('verification_') and await index.client.collection_exists(index.collection):await index.client.delete_collection(index.collection)
        await index.close();await provider.close()

if __name__=='__main__':print(json.dumps(asyncio.run(verify()),ensure_ascii=False,indent=2))
