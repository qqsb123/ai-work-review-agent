import json
from pathlib import Path
import httpx
from app.main import create_app
from .helpers import MemoryDB,Provider,DummyRag,tools,call,final,RECORDS
from .test_contract import events,token
from .test_runtime_security import insight_value

async def test_frozen_node_contract_matches_fastapi():
    baseline=json.loads(Path(__file__).with_name('node_contract.json').read_text(encoding='utf-8'))
    db=MemoryDB();provider=Provider();app=create_app(db,provider,DummyRag())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        headers=token();input={'work':'登录模块开发完成并通过自测。','problems':'','nextPlan':'','style':'detailed','useHistory':False}
        response=await client.post('/api/weekly-report/prepare',headers=headers,json=input)
        prepared=next(e['result'] for e in events(response.text) if e['type']=='result')
        assert sorted(prepared)==baseline['prepareKeys']
        response=await client.post('/api/weekly-report',headers=headers,json={'sessionId':prepared['sessionId'],'answers':[],'skipClarification':True})
        generated=next(e['result'] for e in events(response.text) if e['type']=='result')
        assert sorted(generated)==baseline['generateKeys'] and generated['content']==baseline['generatedContent']
        confirmation=await client.post('/api/weekly-report/confirm',headers=headers,json={'sessionId':generated['sessionId'],'content':generated['content'],'confirm':True})
        assert sorted(confirmation.json())==baseline['confirmKeys']
        provider.responses=[tools(call('read_report',{'reportId':1},'r1'),call('read_report',{'reportId':2},'r2')),final(insight_value())]
        response=await client.post('/api/ai/insights',headers=headers,json={'question':''})
        result=next(e['result'] for e in events(response.text) if e['type']=='result')
        assert sorted(result)==baseline['insightKeys']
        assert [{'key':s['key'],'title':s['title']} for s in result['sections']]==baseline['sections']
        assert sorted(result['sources'][0])==baseline['sourceKeys']
        assert response.text.endswith('data: [DONE]\n\n') and baseline['successfulDone']
