"""Local UI QA with actual FastAPI/DeepSeek/RAG and temporary synthetic MySQL."""
import asyncio
import uuid
import secrets
from pathlib import Path
import bcrypt
import uvicorn
from fastapi.staticfiles import StaticFiles
from app.main import create_app
from app.provider import DeepSeek
from app.retrieval import LocalModels,VectorIndex,HybridRetrieval,text_of
from app.config import ROOT
from eval.dataset import records
from .fixtures import temporary_db,insert_records

async def main():
    models=LocalModels();await models.compute(models.load)
    index=VectorIndex(model_version=models.version,collection='preview_'+uuid.uuid4().hex);provider=DeepSeek()
    try:
        async with temporary_db() as db:
            rows=records();await insert_records(db,rows)
            await db.execute('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)',(7,'engineering-demo',bcrypt.hashpw(b'demo-password',bcrypt.gensalt()).decode()))
            for user in (7,8):
                owned=[r for r in rows if r['user_id']==user];vectors,_=await models.embed([text_of(r) for r in owned]);await index.upsert(user,owned,vectors)
            # Public synthetic credentials must NEVER mint production-valid JWTs.
            app=create_app(db,provider,HybridRetrieval(db,models,index),jwt_secret=secrets.token_urlsafe(48))
            app.mount('/',StaticFiles(directory=ROOT.parent/'client'/'dist',html=True),name='ui')
            print('Synthetic FastAPI preview http://127.0.0.1:4175 — engineering-demo / demo-password')
            await uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=4175,log_level='warning')).serve()
    finally:
        if index.collection.startswith('preview_') and await index.client.collection_exists(index.collection):await index.client.delete_collection(index.collection)
        await index.close();await provider.close()

if __name__=='__main__':asyncio.run(main())
