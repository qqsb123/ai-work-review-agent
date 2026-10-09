import re
from contextlib import asynccontextmanager
from app.db import Database
from app.config import ROOT

@asynccontextmanager
async def temporary_db():
    root=Database()
    try:
        async with root.engine.begin() as connection:
            db=Database(connection=connection)
            # Shadow production names on ONE connection. No real business writes.
            ddl=(ROOT/'sql'/'agent-engineering.sql').read_text(encoding='utf-8')
            ddl=re.sub(r'^--.*$','',ddl,flags=re.M).replace('CREATE TABLE IF NOT EXISTS','CREATE TEMPORARY TABLE')
            ddl=re.sub(r',\s*CONSTRAINT fk_trace_run[^\n]*','',ddl)
            for statement in ddl.split(';'):
                if statement.strip():await db.execute(statement)
            await db.execute('CREATE TEMPORARY TABLE users(id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,username VARCHAR(64) UNIQUE,password_hash VARCHAR(255))')
            await db.execute('''CREATE TEMPORARY TABLE reports(id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,user_id BIGINT UNSIGNED NOT NULL,
                work_content TEXT,problems TEXT,next_plan TEXT,style VARCHAR(16),content MEDIUMTEXT,request_key VARCHAR(36),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY idx_reports_user_request_key(user_id,request_key))''')
            yield db
    finally:await root.close()

async def insert_records(db,rows):
    for row in rows:
        await db.execute('INSERT INTO reports (id,user_id,work_content,problems,next_plan,style,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
            (row['id'],row['user_id'],row.get('work_content',row['content']),row.get('problems',''),row.get('next_plan',''),row.get('style','detailed'),row['content'],row['created_at'],row['updated_at']))
