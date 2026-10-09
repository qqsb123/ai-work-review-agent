import asyncio
import hashlib
import re
import time
import uuid
from qdrant_client import AsyncQdrantClient, models
from .config import settings, ROOT
from .errors import AgentError

def text_of(row): return str(row.get('content') or '')[:6000]
def content_hash(row): return hashlib.sha256(text_of(row).encode()).hexdigest()
def terms(query):
    words=re.findall(r'[a-z0-9_]{2,}|[\u4e00-\u9fff]+',query.lower())
    parts=[query.lower().strip()]
    for word in words: parts.extend([word[i:i+2] for i in range(len(word)-1)] if re.search('[\u4e00-\u9fff]',word) and len(word)>4 else [word])
    return list(dict.fromkeys(filter(None,parts)))[:12]
def rrf(keyword,dense):
    results={}
    for channel,hits in [('keyword',keyword),('dense',dense)]:
        for rank,row in enumerate(hits,1):
            hit=results.setdefault(row['id'],{**row,'score':0,'channels':[]})
            hit['score']+=1/(60+rank);hit['channels'].append(channel)
    return sorted(results.values(),key=lambda h:(-h['score'],h['id']))

class LocalModels:
    def __init__(self):
        self.embedding=None;self.cross=None;self.gate=asyncio.Semaphore(1);self.pending=set()
        self.version=hashlib.sha256((settings.embedding_model+':'+settings.embedding_revision).encode()).hexdigest()[:32]
    def load(self):
        from sentence_transformers import SentenceTransformer,CrossEncoder
        if self.embedding is None:
            import torch
            torch.set_num_threads(4)
        if self.embedding is None: self.embedding=SentenceTransformer(settings.embedding_path or settings.embedding_model,device='cpu',cache_folder=str(ROOT/'.cache'/'models'),trust_remote_code=False,local_files_only=bool(settings.embedding_path),revision=settings.embedding_revision if not settings.embedding_path else None)
        if self.cross is None: self.cross=CrossEncoder(settings.reranker_path or settings.reranker_model,device='cpu',max_length=512,cache_folder=str(ROOT/'.cache'/'models'),trust_remote_code=False,local_files_only=bool(settings.reranker_path))
    async def compute(self,fn):
        # Cancellation drops the result, but never admits a second CPU inference
        # while a cancelled thread is still running. No unbounded thread queue.
        await self.gate.acquire()
        task=asyncio.create_task(asyncio.to_thread(fn));self.pending.add(task)
        def done(t):
            self.pending.discard(t);self.gate.release()
            if not t.cancelled(): t.exception()
        task.add_done_callback(done)
        return await asyncio.shield(task)
    async def embed(self,texts,query=False):
        def work():
            self.load()
            prefix='query: ' if query else 'passage: '
            strings=[prefix+t for t in texts]
            token_count=sum(len(ids) for ids in self.embedding.tokenizer(strings,truncation=True,max_length=512)['input_ids'])
            vectors=self.embedding.encode(strings,normalize_embeddings=True,show_progress_bar=False).tolist()
            return vectors,token_count
        return await self.compute(work)
    async def rerank(self,query,rows):
        def work():
            self.load();pairs=[(query,text_of(row)) for row in rows]
            encoded=self.cross.tokenizer([p[0] for p in pairs],[p[1] for p in pairs],truncation=True,max_length=512)
            tokens=sum(len(ids) for ids in encoded['input_ids'])
            scores=self.cross.predict(pairs,show_progress_bar=False,batch_size=8).tolist()
            return [row for _,row in sorted(zip(scores,rows),key=lambda x:float(x[0]),reverse=True)],tokens
        return await self.compute(work)

class VectorIndex:
    def __init__(self,client=None,model_version=None,collection=None):
        self.client=client or AsyncQdrantClient(url=settings.qdrant_url,api_key=settings.qdrant_key,timeout=10)
        self.version=model_version or hashlib.sha256((settings.embedding_model+':'+settings.embedding_revision).encode()).hexdigest()[:32]
        self.collection=collection or 'work_reports_'+self.version
        self.ready=False;self.lock=asyncio.Lock()
    def point_id(self,user_id,report_id): return str(uuid.uuid5(uuid.NAMESPACE_URL,f'{self.collection}:{user_id}:{report_id}'))
    def owner_filter(self,user_id): return models.Filter(must=[models.FieldCondition(key='userId',match=models.MatchValue(value=user_id)),models.FieldCondition(key='modelVersion',match=models.MatchValue(value=self.version))])
    async def ensure(self,size):
        async with self.lock:
            if self.ready: return
            if not await self.client.collection_exists(self.collection):
                await self.client.create_collection(self.collection,vectors_config=models.VectorParams(size=size,distance=models.Distance.COSINE))
                await self.client.create_payload_index(self.collection,'userId',models.PayloadSchemaType.INTEGER)
                await self.client.create_payload_index(self.collection,'modelVersion',models.PayloadSchemaType.KEYWORD)
            info=await self.client.get_collection(self.collection)
            if info.config.params.vectors.size!=size: raise ValueError('VECTOR_DIMENSION_MISMATCH')
            self.ready=True
    async def stale(self,user_id,rows):
        if not rows or not await self.client.collection_exists(self.collection): return rows
        points=await self.client.retrieve(self.collection,[self.point_id(user_id,r['id']) for r in rows],with_payload=True)
        hashes={p.payload['reportId']:p.payload.get('contentHash') for p in points if p.payload.get('userId')==user_id and p.payload.get('modelVersion')==self.version}
        return [row for row in rows if hashes.get(row['id'])!=content_hash(row)]
    async def upsert(self,user_id,rows,vectors):
        if not rows:return
        await self.ensure(len(vectors[0]))
        await self.client.upsert(self.collection,points=[models.PointStruct(id=self.point_id(user_id,row['id']),vector=vector,
            payload={'userId':user_id,'reportId':row['id'],'contentHash':content_hash(row),'modelVersion':self.version}) for row,vector in zip(rows,vectors)],wait=True)
    async def search(self,user_id,vector,limit=50):
        await self.ensure(len(vector))
        return (await self.client.query_points(self.collection,query=vector,query_filter=self.owner_filter(user_id),limit=limit,with_payload=True)).points
    async def invalidate(self,user_id,report_id):
        if await self.client.collection_exists(self.collection): await self.client.delete(self.collection,points_selector=models.PointIdsList(points=[self.point_id(user_id,report_id)]),wait=True)
    async def close(self): await self.client.close()

class HybridRetrieval:
    def __init__(self,db,models=None,index=None):
        self.db=db;self.models=models or LocalModels();self.index=index or VectorIndex(model_version=self.models.version)
    async def keyword(self,query,user_id):
        tokens=terms(query)
        if not tokens:return []
        sql='SELECT id,LEFT(content,6000) AS content,created_at,updated_at FROM reports WHERE user_id=? AND ('+' OR '.join('LOCATE(?,LOWER(content))>0' for _ in tokens)+') ORDER BY created_at DESC,id DESC LIMIT 50'
        rows=(await self.db.execute(sql,(user_id,*tokens))).rows
        return sorted(rows,key=lambda r:-sum(len(t) for t in tokens if t in text_of(r).lower()))
    async def search(self,query,ctx,limit=6,mode='rerank'):
        started=time.monotonic();user_id=ctx['userId'];fallback=[];metrics={};dense=[]
        budget=ctx.setdefault('retrievalBudget',{'remaining':80000,'pending':0,'embeddingTokens':0,'rerankTokens':0,'documents':0,'estimated':False})
        def charge(texts,kind,actual=None):
            cost=actual if actual is not None else len(''.join(texts).encode())
            if cost>budget['remaining']: raise AgentError('RETRIEVAL_BUDGET','检索预算不足')
            budget['remaining']-=cost;budget['pending']+=cost;budget[kind]+=cost
            if actual is None:budget['estimated']=True
        keyword=await self.keyword(query,user_id) if mode!='dense' else []
        if mode!='keyword':
            try:
                async with asyncio.timeout(settings.retrieval_timeout):
                    recent=(await self.db.execute('SELECT id,LEFT(content,6000) AS content,created_at,updated_at FROM reports WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200',(user_id,))).rows
                    phase=time.monotonic()
                    try:
                        missing=(await self.index.stale(user_id,[r for r in recent if text_of(r).strip()]))[:max(0,12-budget['documents'])]
                    except asyncio.CancelledError: raise
                    except Exception: missing=[];fallback.append('VECTOR_DB_UNAVAILABLE');raise RuntimeError('vector') from None
                    selected=[]
                    for row in missing:
                        if len((query+''.join(text_of(r) for r in selected)+text_of(row)).encode())<=budget['remaining']:selected.append(row)
                    try:
                        if len(query.encode())>budget['remaining']:raise AgentError('RETRIEVAL_BUDGET','检索预算不足')
                        vector,qtokens=await self.models.embed([query],query=True);charge([query],'embeddingTokens',qtokens)
                        if selected:
                            vectors,dtokens=await self.models.embed([text_of(r) for r in selected]);charge([text_of(r) for r in selected],'embeddingTokens',dtokens)
                            budget['documents']+=len(selected)
                    except asyncio.CancelledError: raise
                    except Exception:fallback.append('EMBEDDING_UNAVAILABLE');raise RuntimeError('embedding') from None
                    metrics['embeddingDurationMs']=round((time.monotonic()-phase)*1000);phase=time.monotonic()
                    try:
                        if selected:await self.index.upsert(user_id,selected,vectors)
                        points=await self.index.search(user_id,vector[0])
                    except asyncio.CancelledError: raise
                    except Exception:fallback.append('VECTOR_DB_UNAVAILABLE');raise RuntimeError('vector') from None
                    metrics['vectorSearchDurationMs']=round((time.monotonic()-phase)*1000)
                    # Never trust vector payloads as records. SQL revalidates owner,
                    # deletion and content version before returning ANY candidate.
                    eligible=[p for p in points if p.payload.get('userId')==user_id and p.payload.get('modelVersion')==self.index.version and type(p.payload.get('reportId')) is int]
                    if eligible:
                        ids=[p.payload['reportId'] for p in eligible]
                        rows=(await self.db.execute('SELECT id,LEFT(content,6000) AS content,created_at,updated_at FROM reports WHERE user_id=? AND id IN ('+','.join('?' for _ in ids)+')',(user_id,*ids))).rows
                        current={r['id']:r for r in rows}
                        dense=[current[p.payload['reportId']] for p in eligible if p.payload['reportId'] in current and content_hash(current[p.payload['reportId']])==p.payload.get('contentHash')]
            except asyncio.CancelledError: raise
            except TimeoutError:fallback.append('RETRIEVAL_TIMEOUT')
            except Exception:
                if not fallback:fallback.append('RETRIEVAL_UNAVAILABLE')
        fused=rrf(keyword,dense) if mode not in ('keyword','dense') else [dict(r,channels=[mode]) for r in (keyword if mode=='keyword' else dense)]
        reranked=0;actual_mode='keyword' if fallback and not dense else mode
        if mode=='rerank' and fused:
            try:
                phase=time.monotonic();candidates=fused[:20]
                reserve=len(''.join(query+text_of(r) for r in candidates).encode())
                if reserve>budget['remaining']:raise AgentError('RETRIEVAL_BUDGET','重排序预算不足')
                async with asyncio.timeout(settings.retrieval_timeout): result,tokens=await self.models.rerank(query,candidates)
                charge([query+text_of(r) for r in candidates],'rerankTokens',tokens);fused=result;reranked=len(result)
                metrics['rerankDurationMs']=round((time.monotonic()-phase)*1000)
            except asyncio.CancelledError:raise
            except Exception:fallback.append('RERANKER_UNAVAILABLE');actual_mode='rrf' if dense else 'keyword'
        metrics.update(mode=actual_mode,keywordCount=len(keyword),vectorCount=len(dense),rrfCount=len(rrf(keyword,dense)),rerankCount=reranked,
            selectedReportIds=[r['id'] for r in fused[:limit]],fallbackReasons=list(dict.fromkeys(fallback)),totalRetrievalDurationMs=round((time.monotonic()-started)*1000),
            embeddingTokens=budget['embeddingTokens'],rerankTokens=budget['rerankTokens'],remainingBudget=budget['remaining'],semanticWindow=200,
            limitation='仅候选，不是Evidence。read_report校验真实原文；在线每Run最多补索引12份，预索引覆盖另行记录。')
        return {'reports':[{'id':r['id'],'summary':text_of(r)[:300],'createdAt':str(r['created_at']),'updatedAt':str(r['updated_at']),'channels':r.get('channels',[])} for r in fused[:limit]],'retrieval':metrics,'untrusted':True}
