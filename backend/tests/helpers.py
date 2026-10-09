import json
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from app.db import Result

RECORDS=[
    {'id':1,'user_id':7,'work_content':'登录模块开发完成并通过自测。','problems':'','next_plan':'完成权限模块','style':'detailed','content':'所属周期：2026-09-01。本周登录模块开发完成并通过自测。','created_at':'2026-09-01','updated_at':'2026-09-01'},
    {'id':2,'user_id':7,'work_content':'权限模块正在进行联调。','problems':'','next_plan':'','style':'detailed','content':'所属周期：2026-09-08。权限模块正在进行联调。','created_at':'2026-09-08','updated_at':'2026-09-08'},
    {'id':3,'user_id':8,'work_content':'秘密登录项目已上线。','problems':'','next_plan':'','style':'detailed','content':'秘密登录项目已上线。','created_at':'2026-09-10','updated_at':'2026-09-10'}]

class MemoryDB:
    """Synthetic relational fixture; real SQL semantics verified separately."""
    def __init__(self,rows=None):
        self.rows=[dict(r) for r in (RECORDS if rows is None else rows)];self.users=[];self.runs={};self.events=[];self.drafts={};self.writes=0;self.queries=[];self.lock=asyncio.Lock()
    @asynccontextmanager
    async def transaction(self):
        async with self.lock:yield self
    async def execute(self,sql,args=()):
        self.queries.append((sql,args));low=' '.join(sql.lower().split())
        if 'agent_runs' in low and 'agent_run_events' not in low:
            if low.startswith('insert'):
                run_id,user,key,task,fingerprint,input=args
                if (user,key) not in self.runs:self.runs[user,key]={'run_id':run_id,'user_id':user,'request_key':key,'task':task,'input_hash':fingerprint,'input_json':input,'status':'pending','attempt':0,'checkpoint_json':None,'result_json':None,'error_code':None,'created_at':'2026-10-07','lease_until':None}
                return Result([],1)
            if low.startswith('select'):
                if 'request_key=?' in low:rows=[self.runs[args]] if args in self.runs else []
                elif 'run_id=?' in low:rows=[r for r in self.runs.values() if r['run_id']==args[0] and r['user_id']==args[1]]
                else:rows=[{'runId':r['run_id'],'task':r['task'],'status':r['status'],'attempt':r['attempt'],'createdAt':r['created_at'],'leaseUntil':r['lease_until']} for r in self.runs.values() if r['user_id']==args[0]]
                return Result([dict(r) for r in rows])
            if "status='running',attempt" in low:
                token,id,user,retry=args;row=next(r for r in self.runs.values() if r['run_id']==id)
                if row['user_id']!=user or row['attempt']>=3 or not (row['status']=='pending' or retry and (row['status'] in ('failed','aborted','timed_out','validation_error') or row.get('expired'))):return Result([],0)
                row.update(status='running',attempt=row['attempt']+1,lease_token=token,error_code=None,expired=False);return Result([],1)
            if low.startswith('update'):
                id,user,token=args[-3:];row=next(r for r in self.runs.values() if r['run_id']==id)
                if row['user_id']!=user or row.get('lease_token')!=token or row['status']!='running':return Result([],0)
                if 'checkpoint_json' in low:row['checkpoint_json']=args[0]
                else:row.update(status=args[0],result_json=args[1],error_code=args[2],lease_until=None)
                return Result([],1)
        if 'agent_run_events' in low:
            if low.startswith('insert'):
                event,id,user,token=args;row=next(r for r in self.runs.values() if r['run_id']==id)
                if row['user_id']!=user or row.get('lease_token')!=token or row['status']!='running':return Result([],0)
                self.events.append({'run_id':id,'user_id':user,'event_json':event});return Result([],1)
            return Result([{'event_json':e['event_json']} for e in self.events if e['run_id']==args[0] and e['user_id']==args[1]])
        if 'agent_drafts' in low:
            if low.startswith('insert'):self.drafts[args[0],args[1]]=json.loads(args[2]);return Result([],1)
            if low.startswith('select'):
                draft=self.drafts.get(tuple(args));return Result([{'draft_json':json.dumps(draft)}] if draft else [])
            draft=self.drafts.get((args[1],args[2]))
            if not draft:return Result([],0)
            if "$.state" in low:
                if draft['state']!='prepared' and not (draft['state']=='generating' and draft.get('generationStartedAt',0)<args[3]):return Result([],0)
            elif draft.get('generationToken')!=args[3]:return Result([],0)
            self.drafts[args[1],args[2]]=json.loads(args[0]);return Result([],1)
        if 'users' in low:
            if low.startswith('insert'):
                id=len(self.users)+1;self.users.append({'id':id,'username':args[0],'password_hash':args[1]});return Result([],1,id)
            return Result([dict(u) for u in self.users if u['username']==args[0]])
        if 'reports' in low:
            if low.startswith('insert'):
                user,work,problems,plan,style,content,key=args
                row=next((r for r in self.rows if r['user_id']==user and r.get('request_key')==key),None)
                if not row:
                    row={'id':max([r['id'] for r in self.rows]+[0])+1,'user_id':user,'work_content':work,'problems':problems,'next_plan':plan,'style':style,'content':content,'request_key':key,'created_at':'2026-10-07','updated_at':'2026-10-07'};self.rows.append(row);self.writes+=1
                return Result([],1,row['id'])
            if low.startswith('update'):
                rows=[r for r in self.rows if r['id']==args[1] and r['user_id']==args[2]]
                for r in rows:r['content']=args[0]
                return Result([],len(rows))
            if low.startswith('delete'):
                before=len(self.rows);self.rows=[r for r in self.rows if not (r['id']==args[0] and r['user_id']==args[1])];return Result([],before-len(self.rows))
            if 'request_key=?' in low:return Result([dict(r) for r in self.rows if r['user_id']==args[0] and r.get('request_key')==args[1]])
            if 'where id=? and user_id=?' in low:return Result([dict(r) for r in self.rows if r['id']==args[0] and r['user_id']==args[1]])
            rows=sorted([dict(r) for r in self.rows if r['user_id']==args[0]],key=lambda r:r['id'],reverse=True)
            if 'limit 2' in low and 'next_plan' not in low:return Result(rows[:2])
            if 'id in' in low:return Result([r for r in rows if r['id'] in args[1:]])
            if 'trim(coalesce(next_plan' in low:return Result([r for r in rows if r['next_plan'].strip() and (args[1] is None or r['id']==args[1])][:2])
            if 'created_at>?' in low:
                _,after,_,id,key,_,_,offset=args
                return Result([r for r in rows if (str(r['created_at']),r['id'])>(str(after),id) and (not key or key in r['content'] or key in r['work_content'])][offset:offset+7])
            if 'lower(content)' in low:return Result([r for r in rows if any(t in r['content'].lower() for t in args[1:])][:50])
            if 'locate' in low:
                _,key,_,limit,offset=args;return Result([r for r in rows if not key or key in r['content']][offset:offset+limit])
            return Result(rows[:200])
        raise AssertionError('Unexpected query: '+sql)

def call(name,args,id=None):return {'id':id or name,'type':'function','function':{'name':name,'arguments':json.dumps(args,ensure_ascii=False)}}
def tools(*calls):return {'message':{'role':'assistant','content':None,'tool_calls':list(calls)},'finishReason':'tool_calls','usage':{'total_tokens':100}}
def final(value):return {'message':{'role':'assistant','content':json.dumps(value,ensure_ascii=False)},'finishReason':'stop','usage':{'total_tokens':100}}
class Provider:
    def __init__(self,responses=None,content='登录模块开发完成并通过自测。'):self.responses=list(responses or [final({'questions':[]})]);self.calls=0;self.content=content;self.incomplete=False
    async def complete(self,**kwargs):self.calls+=1;return self.responses.pop(0)
    async def stream(self,messages):
        yield {'type':'content','content':self.content}
        if not self.incomplete:yield {'type':'complete'}
    async def close(self):pass
class DummyIndex:
    async def invalidate(self,*args):pass
    async def close(self):pass
class DummyRag:
    def __init__(self):self.index=DummyIndex()
    async def search(self,query,ctx,limit=6):return {'reports':[{'id':1,'summary':'登录模块'}],'retrieval':{'mode':'keyword','fallbackReasons':['TEST_FIXTURE']}}
async def noop(event):pass
