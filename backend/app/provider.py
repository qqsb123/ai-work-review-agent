import json
import httpx
from .config import settings
from .errors import AgentError

class DeepSeek:
    def __init__(self,client=None):
        self.client=client or httpx.AsyncClient(base_url='https://api.deepseek.com',timeout=settings.model_timeout)
    def headers(self):
        if not settings.api_key: raise AgentError('MODEL_NOT_CONFIGURED','请配置服务端DeepSeek密钥',503)
        return {'Authorization':f'Bearer {settings.api_key}'}
    async def complete(self,*,messages,tools,max_tokens):
        try:
            response=await self.client.post('/chat/completions',headers=self.headers(),json={'model':settings.agent_model,'messages':messages,'tools':tools,
                'tool_choice':'auto','stream':False,'thinking':{'type':'disabled'},'temperature':0.2,'max_tokens':max_tokens})
            response.raise_for_status();data=response.json();choice=data['choices'][0]
            return {'message':choice['message'],'finishReason':choice['finish_reason'],'usage':data.get('usage')}
        except httpx.TimeoutException: raise AgentError('MODEL_TIMEOUT','模型请求超时，请重试',503) from None
        except (httpx.HTTPError,ValueError,KeyError,IndexError): raise AgentError('MODEL_FAILED','模型服务暂时不可用',503) from None
    async def stream(self,messages):
        """Only upstream stop + DONE produces a complete marker. Cancel closes HTTP."""
        try:
            async with self.client.stream('POST','/chat/completions',headers=self.headers(),json={'model':settings.report_model,'messages':messages,'stream':True,'max_tokens':4000,'temperature':0.7}) as response:
                response.raise_for_status();stop=False;done=False
                async for line in response.aiter_lines():
                    if not line.startswith('data:'): continue
                    raw=line[5:].strip()
                    if raw=='[DONE]': done=True;break
                    if not raw: continue
                    data=json.loads(raw);choice=(data.get('choices') or [{}])[0]
                    if choice.get('finish_reason')=='stop': stop=True
                    elif choice.get('finish_reason') is not None: raise AgentError('STREAM_INCOMPLETE','模型流未正常结束')
                    content=choice.get('delta',{}).get('content')
                    if content: yield {'type':'content','content':content}
                if not stop or not done: raise AgentError('STREAM_INCOMPLETE','模型流提前结束，请重试')
                yield {'type':'complete'}
        except httpx.TimeoutException: raise AgentError('MODEL_TIMEOUT','模型请求超时',503) from None
        except (httpx.HTTPError,ValueError,KeyError): raise AgentError('MODEL_FAILED','模型服务暂时不可用',503) from None
    async def close(self): await self.client.aclose()
