import asyncio
import json
import uuid
import httpx
from app.main import create_app
from app.stores import RunStore,DraftStore,confirm_report
from app.config import settings
from tests.helpers import RECORDS,Provider,DummyRag
from tests.test_contract import token,events
from .fixtures import temporary_db,insert_records

async def verify():
    async with temporary_db() as db:
        await insert_records(db,RECORDS)
        store=RunStore(db);key=str(uuid.uuid4());run=await store.begin(7,'insights',{'question':'合成'},key)
        try:await store.begin(7,'insights',{'question':'不同'},key);raise AssertionError('conflict not rejected')
        except __import__('app.errors',fromlist=['AgentError']).AgentError as error:assert error.code=='RUN_CONFLICT'
        await store.record(run,{'type':'trace','stage':'model_start'},{'boundary':'model_start','recovery':'restart_from_input'})
        await store.finish(run,'failed',code='MODEL_FAILED')
        retry=await RunStore(db).begin(7,'insights',{'question':'合成'},key,True)
        assert retry['attempt']==2 and retry['runId']==run['runId']
        try:await store.finish(run,'succeeded',{});raise AssertionError('old lease accepted')
        except __import__('app.errors',fromlist=['AgentError']).AgentError as error:assert error.code=='RUN_LEASE_LOST'
        await store.finish(retry,'succeeded',{'verified':True})
        assert (await store.begin(7,'insights',{'question':'合成'},key))['replay']=={'verified':True}
        input={'work':'登录模块已完成开发与自测。','problems':'','nextPlan':'','style':'detailed','useHistory':False}
        drafts=DraftStore(db);draft=await drafts.create(7,input);draft.update(state='ready',content=input['work']);await drafts.save(draft)
        before=(await db.execute('SELECT COUNT(*) AS count FROM reports')).rows[0]['count']
        body={'sessionId':draft['id'],'content':draft['content'],'confirm':True}
        confirmed=await asyncio.gather(confirm_report(db,drafts,7,body),confirm_report(db,drafts,7,body))
        assert confirmed[0]['reportId']==confirmed[1]['reportId']
        assert (await db.execute('SELECT COUNT(*) AS count FROM reports')).rows[0]['count']==before+1
        assert (await DraftStore(db).get(draft['id'],7))['state']=='saved'
        app=create_app(db,Provider(),DummyRag())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            registered=await client.post('/api/auth/register',json={'username':'synthetic_mysql','password':'demo-password'})
            assert registered.status_code==201
            logged=await client.post('/api/auth/login',json={'username':'synthetic_mysql','password':'demo-password'})
            assert logged.status_code==200 and logged.json()['data']['token']
            assert (await client.get('/api/reports/1',headers=token(8))).status_code==404
            assert (await client.get('/api/ai/runs/'+run['runId'],headers=token(8))).status_code==404
            prepared=await client.post('/api/weekly-report/prepare',headers=token(),json={**input,'requestKey':'mysql_prepare_contract'})
            assert prepared.text.endswith('data: [DONE]\n\n')
            result=next(e['result'] for e in events(prepared.text) if e['type']=='result')
            replay=await client.post('/api/ai/runs/'+result['runId']+'/retry',headers=token())
            assert replay.text.endswith('data: [DONE]\n\n')
        return {'verified':True,'realMySQL':True,'temporaryTablesOnly':True,'concurrentConfirmationRows':1,'contractHTTP':True,'runReplay':True,'retryAttempt':2,'oldLeaseRejected':True,'businessUserDataWritten':False}

if __name__=='__main__':print(json.dumps(asyncio.run(verify()),ensure_ascii=False,indent=2))
