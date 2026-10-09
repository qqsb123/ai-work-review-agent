import json
import hashlib
import re
import uuid
import time
from datetime import datetime, timedelta, timezone
from .errors import AgentError
from .runtime import dumps

def parse_json(value):
    return json.loads(value) if isinstance(value,str) else value

class RunStore:
    def __init__(self,db): self.db=db
    async def begin(self,user_id,task,input,request_key=None,retry=False):
        request_key=request_key or str(uuid.uuid4())
        if not isinstance(request_key,str) or not re.fullmatch('[a-zA-Z0-9_-]{8,80}',request_key): raise AgentError('RUN_INPUT','请求标识无效')
        # New requests use a deterministic Python hash. Legacy completed runs can
        # also replay if their stored canonical JSON input is equivalent.
        fingerprint=hashlib.sha256((task+':'+json.dumps(input,sort_keys=True,ensure_ascii=False,separators=(',',':'))).encode()).hexdigest()
        run_id=str(uuid.uuid4()); token=str(uuid.uuid4())
        await self.db.execute('INSERT INTO agent_runs (run_id,user_id,request_key,task,input_hash,input_json) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE run_id=run_id',(run_id,user_id,request_key,task,fingerprint,dumps(input)))
        rows=(await self.db.execute('SELECT * FROM agent_runs WHERE user_id=? AND request_key=?',(user_id,request_key))).rows
        row=rows[0]
        if row['task']!=task or parse_json(row['input_json'])!=input: raise AgentError('RUN_CONFLICT','该请求标识已用于不同输入',409)
        if row['status']=='succeeded': return {'runId':row['run_id'],'replay':parse_json(row['result_json']),'userId':user_id}
        claimed=await self.db.execute("""UPDATE agent_runs SET status='running',attempt=attempt+1,lease_token=?,lease_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 240 SECOND),error_code=NULL
            WHERE run_id=? AND user_id=? AND attempt<3 AND (status='pending' OR (?=1 AND (status IN ('failed','aborted','timed_out','validation_error') OR (status='running' AND lease_until<CURRENT_TIMESTAMP(3)))))""",(token,row['run_id'],user_id,int(retry)))
        if claimed.affected!=1: raise AgentError('RUN_CONFLICT','任务正在执行、需显式重试或已达到三次尝试上限',409)
        return {'runId':row['run_id'],'userId':user_id,'requestKey':request_key,'leaseToken':token,'attempt':row['attempt']+1,'seq':0}
    async def record(self,run,event,checkpoint=None):
        run['seq']+=1
        public={**event,'runId':run['runId'],'attempt':run['attempt'],'seq':run['seq'],'timestamp':datetime.now(timezone.utc).isoformat()}
        write=await self.db.execute("INSERT INTO agent_run_events (run_id,user_id,attempt,event_json) SELECT run_id,user_id,attempt,? FROM agent_runs WHERE run_id=? AND user_id=? AND lease_token=? AND status='running'",(dumps(public),run['runId'],run['userId'],run['leaseToken']))
        if write.affected!=1: raise AgentError('RUN_LEASE_LOST','任务执行权已失效',409)
        if checkpoint: await self.db.execute("UPDATE agent_runs SET checkpoint_json=? WHERE run_id=? AND user_id=? AND lease_token=? AND status='running'",(dumps(checkpoint),run['runId'],run['userId'],run['leaseToken']))
        return public
    async def finish(self,run,status,result=None,code=None):
        write=await self.db.execute("UPDATE agent_runs SET status=?,result_json=?,error_code=?,lease_until=NULL WHERE run_id=? AND user_id=? AND lease_token=? AND status='running'",(status,dumps(result) if result is not None else None,code,run['runId'],run['userId'],run['leaseToken']))
        if write.affected!=1: raise AgentError('RUN_LEASE_LOST','任务执行权已失效',409)
    async def get(self,run_id,user_id):
        rows=(await self.db.execute('SELECT * FROM agent_runs WHERE run_id=? AND user_id=?',(run_id,user_id))).rows
        if not rows: raise AgentError('RUN_NOT_FOUND','任务不存在或无权访问',404)
        row=rows[0];events=(await self.db.execute('SELECT event_json FROM agent_run_events WHERE run_id=? AND user_id=? ORDER BY id LIMIT 1000',(run_id,user_id))).rows
        return {'runId':row['run_id'],'requestKey':row['request_key'],'task':row['task'],'status':row['status'],'attempt':row['attempt'],'leaseUntil':row['lease_until'],
            'input':parse_json(row['input_json']),'checkpoint':parse_json(row['checkpoint_json']),'result':parse_json(row['result_json']),'errorCode':row['error_code'],'createdAt':row['created_at'],'events':[parse_json(e['event_json']) for e in events]}
    async def list(self,user_id):
        return (await self.db.execute('SELECT run_id AS runId,task,status,attempt,created_at AS createdAt,lease_until AS leaseUntil FROM agent_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 30',(user_id,))).rows

class DraftStore:
    def __init__(self,db): self.db=db
    async def create(self,user_id,input,questions=None,sources=None):
        draft={'id':str(uuid.uuid4()),'userId':user_id,'input':input,'questions':questions or [],'historySources':sources or [],'state':'prepared','content':'','expiresAt':round((time.time()+7*86400)*1000)}
        await self.db.execute('INSERT INTO agent_drafts (session_id,user_id,draft_json,expires_at) VALUES (?,?,?,?)',(draft['id'],user_id,dumps(draft),datetime.now()+timedelta(days=7)))
        return draft
    async def get(self,session_id,user_id):
        rows=(await self.db.execute('SELECT draft_json FROM agent_drafts WHERE session_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP(3)',(session_id,user_id))).rows
        if not rows: raise AgentError('DRAFT_NOT_FOUND','草稿不存在、已过期或无权访问',404)
        draft=parse_json(rows[0]['draft_json'])
        if draft['state']=='generating' and draft.get('generationStartedAt',0)<time.time()*1000-240000: draft['state']='prepared'
        return draft
    async def claim(self,draft):
        write=await self.db.execute("""UPDATE agent_drafts SET draft_json=? WHERE session_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP(3)
            AND (JSON_UNQUOTE(JSON_EXTRACT(draft_json,'$.state'))='prepared' OR (JSON_UNQUOTE(JSON_EXTRACT(draft_json,'$.state'))='generating' AND CAST(JSON_EXTRACT(draft_json,'$.generationStartedAt') AS UNSIGNED)<?))""",(dumps(draft),draft['id'],draft['userId'],round(time.time()*1000)-240000))
        if write.affected!=1: raise AgentError('DRAFT_STATE','草稿正在生成或已完成',409)
    async def save(self,draft):
        write=await self.db.execute("UPDATE agent_drafts SET draft_json=? WHERE session_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP(3) AND JSON_UNQUOTE(JSON_EXTRACT(draft_json,'$.generationToken')) <=> ?",(dumps(draft),draft['id'],draft['userId'],draft.get('generationToken')))
        if write.affected!=1: raise AgentError('DRAFT_NOT_FOUND','草稿已过期或执行权失效',404)

async def confirm_report(db,store,user_id,body):
    if body.get('confirm') is not True: raise AgentError('CONFIRMATION_REQUIRED','必须明确确认后保存')
    draft=await store.get(body['sessionId'],user_id)
    if draft['state'] not in ('ready','saving','saved') or not draft['content']: raise AgentError('DRAFT_NOT_READY','完整草稿尚未生成')
    if body['content']!=draft['content']: raise AgentError('DRAFT_MISMATCH','确认内容必须与本次校验后的草稿一致')
    # No model tool can reach this function. Atomic business INSERT + saved state.
    async with db.transaction() as tx:
        input=draft.get('generationInput',draft['input'])
        await tx.execute('INSERT INTO reports (user_id,work_content,problems,next_plan,style,content,request_key) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',(user_id,input['work'],input['problems'],input['nextPlan'],input['style'],draft['content'],draft['id']))
        rows=(await tx.execute('SELECT id,content FROM reports WHERE user_id=? AND request_key=?',(user_id,draft['id']))).rows
        if not rows or rows[0]['content']!=draft['content']: raise AgentError('CONFIRMATION_CONFLICT','重复请求正文不一致',409)
        already=draft['state']=='saved';draft.update(state='saved',reportId=rows[0]['id'])
        await DraftStore(tx).save(draft)
    return {'code':0,'reportId':draft['reportId'],'alreadySaved':already}
