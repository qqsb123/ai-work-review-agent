import asyncio
from types import SimpleNamespace
import pytest
from app.retrieval import HybridRetrieval,VectorIndex,content_hash,rrf
from .helpers import MemoryDB,RECORDS

class FixtureModels:
    version='fixture-version'
    async def embed(self,texts,query=False):return [[1.,0.] for _ in texts],len(texts)*2
    async def rerank(self,query,rows):return list(reversed(rows)),4
class FixtureIndex:
    version='fixture-version'
    def __init__(self,points=None):self.points=points or []
    async def stale(self,user,rows):return []
    async def upsert(self,*args):pass
    async def search(self,*args):return self.points
    async def close(self):pass
def point(row,user=None,hash=None):return SimpleNamespace(payload={'userId':user or row['user_id'],'reportId':row['id'],'modelVersion':'fixture-version','contentHash':hash or content_hash(row)})

async def test_vector_owner_version_deletion_and_candidate_not_evidence():
    db=MemoryDB();index=FixtureIndex([point(RECORDS[0]),point(RECORDS[2]),point(RECORDS[1],hash='old-hash')])
    rag=HybridRetrieval(db,FixtureModels(),index);ctx={'userId':7,'sources':{}}
    result=await rag.search('身份验证',ctx)
    assert [r['id'] for r in result['reports']]==[1] and ctx['sources']=={}
    db.rows=[r for r in db.rows if r['id']!=1]
    result=await rag.search('身份验证',{'userId':7,'sources':{}})
    assert result['reports']==[]
    filt=VectorIndex(model_version='fixture-version').owner_filter(7)
    assert filt.must[0].key=='userId' and filt.must[0].match.value==7

@pytest.mark.parametrize('component,reason',[('vector','VECTOR_DB_UNAVAILABLE'),('embedding','EMBEDDING_UNAVAILABLE'),('rerank','RERANKER_UNAVAILABLE')])
async def test_fallbacks(component,reason):
    db=MemoryDB();models=FixtureModels();index=FixtureIndex([point(RECORDS[0])])
    async def fail(*args,**kwargs):raise RuntimeError('credential and full source must not leak')
    if component=='vector':index.search=fail
    elif component=='embedding':models.embed=fail
    else:models.rerank=fail
    result=await HybridRetrieval(db,models,index).search('登录',{'userId':7})
    assert reason in result['retrieval']['fallbackReasons']
    assert 'credential' not in str(result)
    assert result['reports'][0]['id']==1

async def test_cancel_does_not_become_degradation():
    models=FixtureModels();started=asyncio.Event()
    async def pending(*args,**kwargs):started.set();await asyncio.Event().wait()
    models.embed=pending
    task=asyncio.create_task(HybridRetrieval(MemoryDB(),models,FixtureIndex()).search('登录',{'userId':7}))
    await started.wait();task.cancel()
    with pytest.raises(asyncio.CancelledError):await task

def test_rrf_scales_by_rank_not_raw_score():
    rows=rrf([{'id':1},{'id':2}],[{'id':2},{'id':3}])
    assert rows[0]['id']==2 and rows[0]['channels']==['keyword','dense']
