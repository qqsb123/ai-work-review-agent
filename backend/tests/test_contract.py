import json
import pytest
import httpx
import jwt
from datetime import datetime,timedelta,timezone
from app.main import create_app
from app.config import settings
from .helpers import MemoryDB,Provider,DummyRag,tools,call,final,RECORDS
from .test_runtime_security import insight_value

def token(user_id=7):return {'Authorization':'Bearer '+jwt.encode({'userId':user_id,'exp':datetime.now(timezone.utc)+timedelta(hours=1)},settings.jwt_secret,algorithm='HS256')}
def events(text):return [json.loads(part[6:]) for part in text.split('\n\n') if part.startswith('data: ') and part!='data: [DONE]']

async def test_auth_crud_contract_and_owner_isolation():
    db=MemoryDB();app=create_app(db,Provider(),DummyRag())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.get('/api/reports')).status_code==401
        created=await client.post('/api/auth/register',json={'username':'synthetic','password':'password-demo'})
        assert created.status_code==201 and set(created.json()['data'])=={'id','username'}
        assert (await client.post('/api/auth/register',json={'username':'synthetic','password':'password-demo'})).status_code==409
        assert (await client.post('/api/auth/login',json={'username':'synthetic','password':'wrong'})).status_code==401
        logged=await client.post('/api/auth/login',json={'username':'synthetic','password':'password-demo'})
        assert set(logged.json()['data'])=={'token','user'}
        headers=token()
        reports=(await client.get('/api/reports',headers=headers)).json()['data']
        assert {r['id'] for r in reports}=={1,2}
        assert (await client.get('/api/reports/3',headers=headers)).status_code==404
        assert (await client.put('/api/reports/3',headers=headers,json={'content':'attack'})).status_code==404
        assert (await client.delete('/api/reports/3',headers=headers)).status_code==404
        assert (await client.put('/api/reports/1',headers=headers,json={'content':'登录模块新增合成验证。'})).status_code==200
        assert (await client.delete('/api/reports/1',headers=headers)).status_code==200

async def test_prepare_generate_confirm_and_replay_contract():
    db=MemoryDB();provider=Provider();app=create_app(db,provider,DummyRag());headers=token()
    body={'work':'登录模块开发完成并通过自测。','problems':'','nextPlan':'','style':'detailed','useHistory':False,'requestKey':'prepare_contract_1'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        before=len(db.rows)
        prepared=await client.post('/api/weekly-report/prepare',headers=headers,json=body)
        assert prepared.status_code==200 and prepared.text.endswith('data: [DONE]\n\n')
        result=next(e['result'] for e in events(prepared.text) if e['type']=='result')
        assert result['questions']==[] and {'sessionId','expiresAt','metrics','runId'}<=set(result)
        repeated=await client.post('/api/weekly-report/prepare',headers=headers,json=body)
        assert provider.calls==1 and result==next(e['result'] for e in events(repeated.text) if e['type']=='result')
        assert (await client.get('/api/ai/runs/'+result['runId'],headers=token(8))).status_code==404
        generated=await client.post('/api/weekly-report',headers=headers,json={'sessionId':result['sessionId'],'skipClarification':True,'answers':[]})
        assert generated.text.endswith('data: [DONE]\n\n') and len(db.rows)==before
        draft=next(e['result'] for e in events(generated.text) if e['type']=='result')
        assert draft['requiresConfirmation'] is True
        assert (await client.post('/api/weekly-report/confirm',headers=headers,json={**{k:draft[k] for k in ('sessionId','content')},'confirm':False})).status_code==400
        assert len(db.rows)==before
        confirmed=await client.post('/api/weekly-report/confirm',headers=headers,json={**{k:draft[k] for k in ('sessionId','content')},'confirm':True})
        twice=await client.post('/api/weekly-report/confirm',headers=headers,json={**{k:draft[k] for k in ('sessionId','content')},'confirm':True})
        assert len(db.rows)==before+1 and confirmed.json()['reportId']==twice.json()['reportId']
        restored=await client.get('/api/weekly-report/drafts/'+result['sessionId'],headers=headers)
        assert restored.json()['state']=='saved'

async def test_insights_and_trace_contract():
    db=MemoryDB();provider=Provider([tools(call('read_report',{'reportId':1},'r1'),call('read_report',{'reportId':2},'r2')),final(insight_value())]);app=create_app(db,provider,DummyRag())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        response=await client.post('/api/ai/insights',headers=token(),json={'question':'权限推进','requestKey':'insight_contract_1'})
        assert response.text.endswith('data: [DONE]\n\n')
        values=events(response.text);result=next(e['result'] for e in values if e['type']=='result')
        assert len(result['sections'])==4 and len(result['sources'])==2
        assert values[0]['type']=='progress'
        assert any(e.get('stage')=='validation_passed' for e in values)
        stored=(await client.get('/api/ai/runs/'+result['runId'],headers=token())).json()
        assert stored['status']=='succeeded' and stored['checkpoint']['recovery']=='restart_from_input'
        replay=await client.post('/api/ai/runs/'+result['runId']+'/retry',headers=token())
        assert replay.text.endswith('data: [DONE]\n\n') and provider.calls==2 and db.writes==0

async def test_incomplete_stream_has_no_result_or_done():
    db=MemoryDB();provider=Provider();provider.incomplete=True;app=create_app(db,provider,DummyRag())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        response=await client.post('/api/weekly-report',headers=token(),json={'work':'合成工作','useHistory':False})
        assert '[DONE]' not in response.text and '"type":"result"' not in response.text
        assert events(response.text)[-1]['type']=='error' and db.writes==0
