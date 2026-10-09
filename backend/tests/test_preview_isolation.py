import httpx
from app.main import create_app
from .helpers import MemoryDB,Provider,DummyRag
from .test_contract import token

async def test_synthetic_preview_jwt_cannot_access_main_app():
    db=MemoryDB();preview=create_app(db,Provider(),DummyRag(),jwt_secret='isolated-preview-secret-012345678901234567890')
    primary=create_app(db,Provider(),DummyRag())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=preview),base_url='http://preview') as client:
        assert (await client.get('/api/reports',headers=token())).status_code==401
        await client.post('/api/auth/register',json={'username':'synthetic_preview','password':'demo-password'})
        logged=await client.post('/api/auth/login',json={'username':'synthetic_preview','password':'demo-password'})
        synthetic=logged.json()['data']['token']
        assert (await client.get('/api/reports',headers={'Authorization':'Bearer '+synthetic})).status_code==200
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=primary),base_url='http://primary') as client:
        assert (await client.get('/api/reports',headers={'Authorization':'Bearer '+synthetic})).status_code==401
