import asyncio
from pathlib import Path
from app.db import Database
from app.config import ROOT

async def migrate(db):
    columns=(await db.execute("SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reports' AND COLUMN_NAME='request_key'")).rows
    if not columns:await db.execute('ALTER TABLE reports ADD COLUMN request_key VARCHAR(36) NULL')
    elif columns[0]['DATA_TYPE']!='varchar' or columns[0]['CHARACTER_MAXIMUM_LENGTH']!=36:raise ValueError('REQUEST_KEY_INCOMPATIBLE')
    indexes=(await db.execute("SELECT COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reports' AND INDEX_NAME='idx_reports_user_request_key' ORDER BY SEQ_IN_INDEX")).rows
    if not indexes:await db.execute('ALTER TABLE reports ADD UNIQUE INDEX idx_reports_user_request_key(user_id,request_key)')
    elif [r['COLUMN_NAME'] for r in indexes]!=['user_id','request_key'] or any(r['NON_UNIQUE'] for r in indexes):raise ValueError('REQUEST_INDEX_INCOMPATIBLE')
    import re
    ddl=re.sub(r'^--.*$','',(ROOT/'sql'/'agent-engineering.sql').read_text(encoding='utf-8'),flags=re.M)
    for statement in ddl.split(';'):
        if statement.strip():await db.execute(statement)
    required={'agent_runs':['run_id','user_id','request_key','task','input_hash','input_json','status','attempt','lease_token','lease_until','checkpoint_json','result_json','error_code','created_at','updated_at'],
        'agent_run_events':['id','run_id','user_id','attempt','event_json','created_at'],
        'agent_drafts':['session_id','user_id','draft_json','expires_at','updated_at']}
    for table,names in required.items():
        fields=(await db.execute('SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',(table,))).rows
        if set(names)-{f['COLUMN_NAME'] for f in fields}:raise ValueError('ENGINEERING_SCHEMA_INCOMPATIBLE')
        if any(f['DATA_TYPE']!='json' for f in fields if f['COLUMN_NAME'] in ('input_json','checkpoint_json','result_json','event_json','draft_json')):raise ValueError('ENGINEERING_SCHEMA_INCOMPATIBLE')
    run_index=(await db.execute("SELECT COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_runs' AND INDEX_NAME='idx_run_request' ORDER BY SEQ_IN_INDEX")).rows
    if [r['COLUMN_NAME'] for r in run_index]!=['user_id','request_key'] or any(r['NON_UNIQUE'] for r in run_index):raise ValueError('RUN_INDEX_INCOMPATIBLE')
    print('MySQL additive migration verified; existing reports preserved.')

async def main():
    db=Database()
    try:await migrate(db)
    finally:await db.close()

if __name__=='__main__':asyncio.run(main())
