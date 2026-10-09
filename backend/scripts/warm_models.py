import asyncio
import json
from app.retrieval import LocalModels
from app.config import settings

async def main():
    models=LocalModels()
    await models.compute(models.load)
    vectors,tokens=await models.embed(['身份验证和访问控制'],query=True)
    rows=[{'id':1,'content':'登录模块完成开发和自测。'},{'id':2,'content':'采购办公用品。'}]
    ranked,rerank_tokens=await models.rerank('用户认证功能的进展',rows)
    print(json.dumps({'verified':True,'embeddingModel':settings.embedding_model,'dimensions':len(vectors[0]),'embeddingTokens':tokens,
        'crossEncoder':settings.reranker_model,'rankedIds':[r['id'] for r in ranked],'rerankTokens':rerank_tokens},ensure_ascii=False))

if __name__=='__main__':asyncio.run(main())
