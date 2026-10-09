import asyncio
import json
import pytest
import httpx
from app.runtime import run_agent,Limits
from app.tools import build_tools
from app.errors import AgentError,ToolInputError
from app.provider import DeepSeek
from app.stores import RunStore,DraftStore
from app.lifecycle import stream_response,persisted_work
from .helpers import MemoryDB,Provider,DummyRag,call,tools,final,noop

async def test_duplicate_ids_and_malformed_calls_rejected_before_tools():
    db=MemoryDB()
    for response in [tools(call('read_report',{'reportId':1},'same'),call('read_report',{'reportId':2},'same')),tools({'id':None,'type':'function'}),{**final({}),'finishReason':'tool_calls'}]:
        provider=Provider([response])
        with pytest.raises(AgentError):await run_agent(messages=[{'role':'user','content':'x'}],registry=build_tools(db,DummyRag()),complete=provider.complete,context={'userId':7,'sources':{}},validate=lambda *_:{},emit=noop)
        assert db.queries==[]

async def test_missing_usage_and_bounded_repairs():
    db=MemoryDB();response=final({});response.pop('usage');provider=Provider([response])
    _,metrics=await run_agent(messages=[{'role':'user','content':'中文输入'}],registry=build_tools(db,enabled=False),complete=provider.complete,context={'userId':7,'sources':{}},validate=lambda *_:{},emit=noop)
    assert metrics['usageEstimated'] and metrics['totalTokens']>3000
    provider=Provider([final({}) for _ in range(3)]);events=[]
    async def emit(event):events.append(event)
    def invalid(*_):raise ValueError()
    with pytest.raises(AgentError) as error:await run_agent(messages=[{'role':'user','content':'x'}],registry=build_tools(db,enabled=False),complete=provider.complete,context={'userId':7,'sources':{}},validate=invalid,emit=emit)
    assert error.value.code=='AGENT_EVIDENCE_INVALID' and provider.calls==3
    assert len([e for e in events if e['stage']=='validation_error'])==3

async def test_source_truncation_pagination_and_read_limit():
    db=MemoryDB();db.rows[0]['content']='原文'*4000;registry=build_tools(db);ctx={'userId':7,'sources':{}}
    source=await registry.execute(call('read_report',{'reportId':1}),ctx)
    assert len(source['content'])==6000 and source['truncated'] is True
    page=await registry.execute(call('search_reports',{'limit':1,'offset':0}),ctx)
    assert page['hasMore'] is True and page['nextOffset']==1
    ctx['sources']={i:{'id':i} for i in range(10,18)}
    with pytest.raises(ToolInputError):await registry.execute(call('read_report',{'reportId':2}),ctx)

async def test_three_attempt_cap_and_stale_draft_token():
    db=MemoryDB();store=RunStore(db);run=await store.begin(7,'plans',{},'three_attempts')
    await store.finish(run,'failed')
    for _ in range(2):run=await store.begin(7,'plans',{},'three_attempts',True);await store.finish(run,'failed')
    with pytest.raises(AgentError):await store.begin(7,'plans',{},'three_attempts',True)
    drafts=DraftStore(db);draft=await drafts.create(7,{'work':'synthetic'})
    draft.update(state='generating',generationStartedAt=1,generationToken='old')
    await drafts.claim(draft)
    restored=await drafts.get(draft['id'],7);assert restored['state']=='prepared'
    restored.update(state='generating',generationStartedAt=9999999999999,generationToken='new');await drafts.claim(restored)
    draft['state']='ready'
    with pytest.raises(AgentError):await drafts.save(draft)

async def test_disconnect_persists_abort_without_done_or_business_write():
    db=MemoryDB();store=RunStore(db);run=await store.begin(7,'insights',{},'disconnect_test');cleanup=[]
    async def execute(emit):await asyncio.Event().wait()
    async def work(send):await persisted_work(run,store,execute,send)
    response=stream_response(work,lambda:cleanup.append(True));iterator=response.body_iterator
    first=await iterator.__anext__();assert '"type":"progress"' in first
    await iterator.aclose()
    saved=await store.get(run['runId'],7)
    assert saved['status']=='aborted' and cleanup==[True] and db.writes==0
    assert saved['events'][-1]['meta']['code']=='CLIENT_ABORTED'

async def test_provider_timeout_and_stream_stop_done_gate():
    async def timeout(req):raise httpx.ReadTimeout('secret upstream query',request=req)
    client=httpx.AsyncClient(base_url='https://api.deepseek.com',transport=httpx.MockTransport(timeout))
    with pytest.raises(AgentError) as error:await DeepSeek(client).complete(messages=[],tools=[],max_tokens=20)
    assert error.value.code=='MODEL_TIMEOUT' and 'secret' not in error.value.message
    await client.aclose()
    for ending,valid in [('data: [DONE]\n\n',False),('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',True)]:
        text='data: '+json.dumps({'choices':[{'delta':{'content':'中文分块'},'finish_reason':None}]},ensure_ascii=False)+'\n\n'+ending
        async def transport(req):return httpx.Response(200,content=text.encode())
        client=httpx.AsyncClient(base_url='https://api.deepseek.com',transport=httpx.MockTransport(transport))
        if valid:
            values=[e async for e in DeepSeek(client).stream([])]
            assert values[-1]['type']=='complete' and values[0]['content']=='中文分块'
        else:
            with pytest.raises(AgentError):[e async for e in DeepSeek(client).stream([])]
        await client.aclose()
