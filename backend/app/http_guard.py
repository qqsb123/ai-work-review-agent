import json
from starlette.exceptions import HTTPException

class BodyLimitMiddleware:
    """Preserve the old 1 MiB JSON boundary, including chunked requests."""
    def __init__(self,app,limit=1024*1024):self.app,self.limit=app,limit
    async def __call__(self,scope,receive,send):
        if scope['type']!='http':return await self.app(scope,receive,send)
        headers=dict(scope.get('headers',[]));length=headers.get(b'content-length')
        if length and (not length.isdigit() or int(length)>self.limit):
            await send({'type':'http.response.start','status':413,'headers':[(b'content-type',b'application/json')]})
            await send({'type':'http.response.body','body':b'{"code":413,"message":"Request body too large"}'});return
        total=0
        async def limited_receive():
            nonlocal total
            message=await receive()
            if message['type']=='http.request':
                total+=len(message.get('body',b''))
                if total>self.limit:raise HTTPException(413,'Request body too large')
            return message
        await self.app(scope,limited_receive,send)

async def json_object(request):
    from .errors import AgentError
    try:body=await request.json()
    except json.JSONDecodeError:raise AgentError('REQUEST_INPUT','请求必须是有效JSON') from None
    if not isinstance(body,dict):raise AgentError('REQUEST_INPUT','请求必须是JSON对象')
    return body
