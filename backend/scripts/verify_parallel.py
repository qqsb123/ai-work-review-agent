"""Actual concurrent MySQL transactions in isolated, disposable prefixed tables.

Uses the existing application's CREATE TABLE grant, never asks for global CREATE
DATABASE privilege, and never directs a confirmation toward real business tables.
"""
import asyncio
import json
import re
import uuid
from sqlalchemy.ext.asyncio import create_async_engine
from contextlib import asynccontextmanager
from app.config import ROOT
from app.db import Database
from app.stores import DraftStore,confirm_report

TABLES=('users','reports','report_embeddings','agent_runs','agent_run_events','agent_drafts')

class IsolatedTables(Database):
    def __init__(self,prefix,**kwargs):super().__init__(**kwargs);self.prefix=prefix
    async def execute(self,sql,args=()):
        for table in TABLES:sql=re.sub(r'\b'+table+r'\b',self.prefix+table,sql)
        sql=re.sub(r'(CONSTRAINT\s+)(\w+)',lambda m:m[1]+self.prefix+m[2],sql,flags=re.I)
        return await super().execute(sql,args)
    @asynccontextmanager
    async def transaction(self):
        async with self.engine.begin() as connection:yield IsolatedTables(self.prefix,connection=connection)

async def main():
    root=Database();prefix='av_'+uuid.uuid4().hex[:12]+'_'
    if not re.fullmatch(r'av_[0-9a-f]{12}_',prefix):raise ValueError('unsafe test table prefix')
    isolated=IsolatedTables(prefix,engine=root.engine);created=[]
    try:
        existing=(await root.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE ?',(prefix+'%',))).rows
        if existing:raise ValueError('test prefix already exists; nothing deleted')
        schema=re.sub(r'^--.*$','',(ROOT/'sql'/'schema.sql').read_text(encoding='utf-8'),flags=re.M)
        for statement in schema.split(';'):
            if statement.strip().startswith('CREATE TABLE'):
                await isolated.execute(statement);created.append(re.search(r'CREATE TABLE IF NOT EXISTS (\w+)',statement)[1])
        engineering=re.sub(r'^--.*$','',(ROOT/'sql'/'agent-engineering.sql').read_text(encoding='utf-8'),flags=re.M)
        for statement in engineering.split(';'):
            if statement.strip():
                await isolated.execute(statement);created.append(re.search(r'CREATE TABLE IF NOT EXISTS (\w+)',statement)[1])
        await isolated.execute('INSERT INTO users(id,username,password_hash) VALUES (?,?,?)',(7,'synthetic_parallel','not-used-for-login'))
        drafts=DraftStore(isolated)
        draft=await drafts.create(7,{'work':'并发合成确认','problems':'','nextPlan':'','style':'detailed','useHistory':False})
        draft.update(state='ready',content='并发合成确认');await drafts.save(draft)
        body={'sessionId':draft['id'],'content':draft['content'],'confirm':True}
        gate=asyncio.Event()
        async def attempt():
            await gate.wait()
            return await confirm_report(isolated,drafts,7,body)
        first=asyncio.create_task(attempt());second=asyncio.create_task(attempt());gate.set()
        values=await asyncio.gather(first,second)
        rows=(await isolated.execute('SELECT COUNT(*) AS count FROM reports')).rows[0]['count']
        assert rows==1 and values[0]['reportId']==values[1]['reportId']
        assert (await drafts.get(draft['id'],7))['state']=='saved'
        untouched=(await root.execute('SELECT COUNT(*) AS count FROM reports WHERE request_key=? AND user_id=?',(draft['id'],7))).rows[0]['count']
        assert untouched==0,'synthetic identity unexpectedly appeared in real business table; no automatic business deletion attempted'
        print(json.dumps({'verified':True,'separateConnectionTransactions':True,'concurrentAttempts':2,'savedReports':rows,'sameReportId':True,'realUserDataWritten':False}))
    finally:
        try:
            for table in reversed(created):
                name=prefix+table
                if table not in TABLES or not re.fullmatch(r'av_[0-9a-f]{12}_(?:users|reports|report_embeddings|agent_runs|agent_run_events|agent_drafts)',name):raise ValueError('unsafe cleanup target')
                await root.execute(f'DROP TABLE `{name}`')
        finally:await root.close()

if __name__=='__main__':asyncio.run(main())
