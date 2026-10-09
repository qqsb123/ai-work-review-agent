import argparse
import asyncio
import json
from app.db import Database
from app.retrieval import LocalModels,VectorIndex,text_of

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--user',type=int,required=True);args=parser.parse_args()
    if args.user<1:raise ValueError('user必须为正整数')
    db=Database();models=LocalModels();index=VectorIndex(model_version=models.version)
    try:
        await models.compute(models.load)
        rows=(await db.execute('SELECT id,LEFT(content,6000) AS content,created_at,updated_at FROM reports WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200',(args.user,))).rows
        missing=await index.stale(args.user,[r for r in rows if text_of(r).strip()]);tokens=0
        for start in range(0,len(missing),12):
            batch=missing[start:start+12];vectors,used=await models.embed([text_of(r) for r in batch]);tokens+=used;await index.upsert(args.user,batch,vectors)
        print(json.dumps({'indexed':len(missing),'window':len(rows),'tokens':tokens,'formalReportsModified':False}))
    finally:await index.close();await db.close()

if __name__=='__main__':asyncio.run(main())
