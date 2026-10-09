import httpx
from app.main import create_app
from .helpers import MemoryDB,Provider,DummyRag
from .test_contract import token

async def test_large_malformed_and_non_object_bodies_rejected_before_model():
    provider=Provider();db=MemoryDB();app=create_app(db,provider,DummyRag())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        oversized=await client.post('/api/weekly-report/prepare',headers=token(),json={'work':'x','extra':'x'*1100000})
        assert oversized.status_code==413
        malformed=await client.post('/api/weekly-report/prepare',headers={**token(),'Content-Type':'application/json'},content='{broken')
        assert malformed.status_code==400
        array=await client.post('/api/weekly-report/prepare',headers=token(),json=[])
        assert array.status_code==400 and provider.calls==0 and db.writes==0
