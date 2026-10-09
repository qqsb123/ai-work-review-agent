import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime,timedelta,timezone
import bcrypt
import jwt
from fastapi import FastAPI, APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import IntegrityError
from .config import settings
from .db import Database
from .errors import AgentError
from .models import LoginInput,ConfirmInput,normalize_input
from .stores import RunStore,DraftStore,confirm_report
from .provider import DeepSeek
from .retrieval import HybridRetrieval
from .tasks import run_task
from .lifecycle import Concurrency,stream_response,persisted_work
from .weekly import continue_draft,validate_draft,conservative
from .prompts import weekly_prompt,rewrite_prompt,UNTRUSTED
from .tools import build_tools
from .http_guard import BodyLimitMiddleware,json_object

def create_app(db=None,provider=None,retrieval=None,jwt_secret=None):
    database=db or Database();model=provider or DeepSeek();rag=retrieval or HybridRetrieval(database)
    auth_secret=jwt_secret or settings.jwt_secret
    runs=RunStore(database);drafts=DraftStore(database);concurrency=Concurrency();confirmations=set()
    @asynccontextmanager
    async def lifespan(app):
        yield
        await asyncio.gather(*confirmations,return_exceptions=True)
        # Injected test/preview resources remain owned by their caller, which
        # must clean its isolated Qdrant collection before closing the client.
        for owned,resource in ((provider is None,model),(retrieval is None,rag.index),(db is None,database)):
            if owned and hasattr(resource,'close'):await resource.close()
    app=FastAPI(title='AI Agent 工作复盘平台',lifespan=lifespan)
    app.add_middleware(BodyLimitMiddleware)
    router=APIRouter()
    app.state.db=database;app.state.rag=rag;app.state.runs=runs;app.state.drafts=drafts
    @app.exception_handler(AgentError)
    async def agent_error(req,error):return JSONResponse({'code':error.status,'message':error.message,'errorCode':error.code},status_code=error.status)
    @app.exception_handler(RequestValidationError)
    async def input_error(req,error):return JSONResponse({'code':400,'message':'请求参数格式无效'},status_code=400)
    @app.exception_handler(Exception)
    async def unexpected(req,error):return JSONResponse({'code':500,'message':'服务暂时不可用'},status_code=500)
    async def auth(request:Request):
        parts=request.headers.get('authorization','').split()
        if len(parts)!=2 or parts[0]!='Bearer':raise AgentError('AUTH_REQUIRED','未提供有效登录凭证',401)
        try:
            payload=jwt.decode(parts[1],auth_secret,algorithms=['HS256'],options={'require':['exp','userId']})
            if type(payload['userId']) is not int or payload['userId']<=0:raise ValueError()
            return payload['userId']
        except (jwt.PyJWTError,ValueError):raise AgentError('AUTH_INVALID','登录凭证无效或已过期',401) from None
    @router.get('/api/health')
    async def health():return {'code':0,'message':'ok','backend':'fastapi'}
    @router.post('/api/auth/register',status_code=201)
    async def register(body:LoginInput):
        username=body.username.strip()
        if not username:raise AgentError('AUTH_INPUT','用户名不能为空')
        if (await database.execute('SELECT id FROM users WHERE username=?',(username,))).rows:raise AgentError('USER_EXISTS','用户名已存在',409)
        # bcryptjs historically truncates UTF-8 passwords at 72 bytes. Preserve
        # verification of existing hashes (including $2a$); never log passwords.
        hashed=await asyncio.to_thread(bcrypt.hashpw,body.password.encode()[:72],bcrypt.gensalt(rounds=10))
        try:inserted=await database.execute('INSERT INTO users (username,password_hash) VALUES (?,?)',(username,hashed.decode()))
        except IntegrityError:raise AgentError('USER_EXISTS','用户名已存在',409) from None
        return {'code':0,'data':{'id':inserted.inserted,'username':username}}
    @router.post('/api/auth/login')
    async def login(body:LoginInput):
        rows=(await database.execute('SELECT id,username,password_hash FROM users WHERE username=?',(body.username.strip(),))).rows
        if not rows or not await asyncio.to_thread(bcrypt.checkpw,body.password.encode()[:72],rows[0]['password_hash'].encode()):raise AgentError('LOGIN_INVALID','用户名或密码错误',401)
        user=rows[0]
        token=jwt.encode({'userId':user['id'],'username':user['username'],'exp':datetime.now(timezone.utc)+timedelta(days=7)},auth_secret,algorithm='HS256')
        return {'code':0,'data':{'token':token,'user':{'id':user['id'],'username':user['username']}}}
    @router.get('/api/reports')
    async def reports(user_id:int=Depends(auth)):
        rows=(await database.execute('SELECT id,work_content,problems,next_plan,style,content,created_at,updated_at FROM reports WHERE user_id=? ORDER BY created_at DESC',(user_id,))).rows
        return {'code':0,'data':rows}
    @router.get('/api/reports/{report_id}')
    async def report(report_id:int,user_id:int=Depends(auth)):
        rows=(await database.execute('SELECT id,work_content,problems,next_plan,style,content,created_at,updated_at FROM reports WHERE id=? AND user_id=?',(report_id,user_id))).rows
        if not rows:raise AgentError('REPORT_NOT_FOUND','周报不存在',404)
        return {'code':0,'data':rows[0]}
    @router.put('/api/reports/{report_id}')
    async def edit(report_id:int,request:Request,user_id:int=Depends(auth)):
        body=await json_object(request);content=body.get('content')
        if not isinstance(content,str) or not content.strip() or len(content)>20000:raise AgentError('REPORT_INPUT','正文为空或过长')
        write=await database.execute('UPDATE reports SET content=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',(content.strip(),report_id,user_id))
        if not write.affected:raise AgentError('REPORT_NOT_FOUND','周报不存在或无权修改',404)
        try:await rag.index.invalidate(user_id,report_id)
        except Exception:pass # Retrieval hash + SQL gate still rejects stale points.
        return {'code':0,'message':'修改成功'}
    @router.delete('/api/reports/{report_id}')
    async def delete(report_id:int,user_id:int=Depends(auth)):
        write=await database.execute('DELETE FROM reports WHERE id=? AND user_id=?',(report_id,user_id))
        if not write.affected:raise AgentError('REPORT_NOT_FOUND','周报不存在或无权删除',404)
        try:await rag.index.invalidate(user_id,report_id)
        except Exception:pass
        return {'code':0,'message':'删除成功'}

    async def start_agent(task,body,user_id):
        if task=='clarification':input=normalize_input(body)
        elif task=='insights':
            question=body.get('question','')
            if not isinstance(question,str) or len(question)>1000:raise AgentError('AGENT_INPUT','复盘重点格式无效')
            input={'question':question.strip()}
        else:
            id=body.get('reportId')
            if id is not None and (type(id) is not int or id<1):raise AgentError('AGENT_INPUT','计划来源必须为正整数')
            input={'reportId':id} if id is not None else {}
        if type(body.get('retry',False)) is not bool:raise AgentError('RUN_INPUT','retry必须为布尔值')
        concurrency.rate(user_id);concurrency.acquire(user_id)
        try:
            async with asyncio.timeout(10):
                if task=='insights' and len((await database.execute('SELECT id FROM reports WHERE user_id=? LIMIT 2',(user_id,))).rows)<2:raise AgentError('HISTORY_REQUIRED','至少需要2份历史周报才能复盘')
                run=await runs.begin(user_id,task,input,body.get('requestKey'),body.get('retry',False))
        except BaseException:
            concurrency.release(user_id);raise
        async def execute(emit):
            result,metrics=await run_task(task,input,user_id,database,model,rag,emit)
            if task=='clarification':
                draft=await drafts.create(user_id,input,result['questions'],result['historySources'])
                result={'sessionId':draft['id'],'questions':draft['questions'],'expiresAt':draft['expiresAt']}
            return result,metrics
        async def work(send):
            await persisted_work(run,runs,execute,send)
        return stream_response(work,lambda:concurrency.release(user_id),timeout=185)
    @router.post('/api/ai/insights')
    async def insights(request:Request,user_id:int=Depends(auth)):return await start_agent('insights',await json_object(request),user_id)
    @router.post('/api/ai/plans')
    async def plans(request:Request,user_id:int=Depends(auth)):return await start_agent('plans',await json_object(request),user_id)
    @router.post('/api/weekly-report/prepare')
    async def prepare(request:Request,user_id:int=Depends(auth)):return await start_agent('clarification',await json_object(request),user_id)
    @router.get('/api/ai/runs')
    async def run_list(user_id:int=Depends(auth)):return {'data':await runs.list(user_id)}
    @router.get('/api/ai/runs/{run_id}')
    async def run_get(run_id:str,user_id:int=Depends(auth)):return await runs.get(run_id,user_id)
    @router.post('/api/ai/runs/{run_id}/retry')
    async def retry(run_id:str,user_id:int=Depends(auth)):
        saved=await runs.get(run_id,user_id)
        return await start_agent(saved['task'],{**saved['input'],'requestKey':saved['requestKey'],'retry':True},user_id)
    @router.get('/api/weekly-report/drafts/{session_id}')
    async def draft_get(session_id:str,user_id:int=Depends(auth)):
        draft=await drafts.get(session_id,user_id)
        return {'sessionId':draft['id'],'input':draft['input'],'questions':draft['questions'],'state':draft['state'],'content':draft['content'],'expiresAt':draft['expiresAt'],'requiresConfirmation':draft['state']=='ready'}
    @router.post('/api/weekly-report/confirm')
    async def confirm(body:ConfirmInput,user_id:int=Depends(auth)):
        task=asyncio.create_task(confirm_report(database,drafts,user_id,body.model_dump()))
        confirmations.add(task);task.add_done_callback(confirmations.discard)
        return await asyncio.shield(task)

    @router.post('/api/weekly-report')
    async def weekly(request:Request,user_id:int=Depends(auth)):
        body=await json_object(request);concurrency.rate(user_id);concurrency.acquire(user_id)
        try:
            async with asyncio.timeout(10):
                draft=await drafts.get(body['sessionId'],user_id) if body.get('sessionId') else await drafts.create(user_id,normalize_input(body))
                continue_draft(draft,body);draft.update(state='generating',generationStartedAt=round(time.time()*1000),generationToken=str(uuid.uuid4()))
                await drafts.claim(draft)
        except BaseException:concurrency.release(user_id);raise
        async def work(send):
            try:
                input=draft['generationInput']
                if input['useHistory'] and not draft['historySources']:
                    registry=build_tools(database,rag);ctx={'userId':user_id,'sources':{}}
                    def call(name,args):return {'id':name,'type':'function','function':{'name':name,'arguments':__import__('json').dumps(args)}}
                    page=await registry.execute(call('search_reports',{'limit':3}),ctx)
                    for item in page['reports']:draft['historySources'].append(await registry.execute(call('read_report',{'reportId':item['id']}),ctx))
                history='\n\n'.join(f"历史#{s['id']}（创建时间非所属周期）\n{s['content'][:1800]}" for s in draft['historySources'])
                unknown='\n'.join(q['question']+'尚未确认' for q in draft.get('unanswered',[]))
                content='';complete=False
                async for event in model.stream([{'role':'system','content':UNTRUSTED+'只能整理真实信息，不补全数字或状态。'},{'role':'user','content':weekly_prompt(input,history,unknown)}]):
                    if event['type']=='content':content+=event['content'];await send(event)
                    elif event['type']=='complete':complete=True
                if not complete:raise AgentError('STREAM_INCOMPLETE','流未完整结束')
                fallback=False
                try:draft['content']=validate_draft(content,draft)
                except AgentError as error:
                    if error.code!='DRAFT_FACT_INVALID':raise
                    draft['content']=conservative(draft);fallback=True
                    await send({'type':'progress','stage':'fallback','message':'草稿未通过事实校验，已按原始信息保守整理'})
                draft['state']='ready';await drafts.save(draft)
                await send({'type':'result','result':{'sessionId':draft['id'],'content':draft['content'],'requiresConfirmation':True,'factCheckFallback':fallback}});await send('[DONE]')
            except BaseException:
                if draft['state']=='generating':draft['state']='prepared'
                try:await asyncio.wait_for(asyncio.shield(asyncio.create_task(drafts.save(draft))),5)
                except Exception:pass
                raise
        return stream_response(work,lambda:concurrency.release(user_id))
    @router.post('/api/ai/rewrite/{report_id}')
    async def rewrite(report_id:int,request:Request,user_id:int=Depends(auth)):
        body=await json_object(request);mode=body.get('mode','professional')
        if mode not in ('professional','concise','okr'):raise AgentError('REWRITE_INPUT','无效重写风格')
        rows=(await database.execute('SELECT id,content FROM reports WHERE id=? AND user_id=?',(report_id,user_id))).rows
        if not rows:raise AgentError('REPORT_NOT_FOUND','周报不存在或无权访问',404)
        content=body.get('content') or rows[0]['content']
        if not isinstance(content,str) or not content.strip() or len(content)>12000:raise AgentError('REWRITE_INPUT','正文为空或过长')
        concurrency.rate(user_id);concurrency.acquire(user_id)
        async def work(send):
            complete=False
            async for event in model.stream([{'role':'system','content':UNTRUSTED},{'role':'user','content':rewrite_prompt(content,mode)}]):
                if event['type']=='complete':complete=True
                else:await send(event)
            if not complete:raise AgentError('STREAM_INCOMPLETE','重写流未完整结束')
            await send('[DONE]')
        return stream_response(work,lambda:concurrency.release(user_id))
    app.include_router(router)
    return app

app=create_app()
