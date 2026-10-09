import asyncio
import logging
from fastapi.responses import StreamingResponse
from .errors import AgentError
from .runtime import dumps

logger=logging.getLogger('agent')

class Concurrency:
    def __init__(self):self.active=set();self.buckets={}
    def acquire(self,user_id):
        if user_id in self.active:raise AgentError('AGENT_BUSY','已有生成或分析正在进行，请先停止或等待完成',409)
        self.active.add(user_id)
    def release(self,user_id):self.active.discard(user_id)
    def rate(self,user_id):
        now=__import__('time').monotonic()
        start,count=self.buckets.get(user_id,(now,0))
        if now-start>=60:start,count=now,0
        if count>=12:raise AgentError('RATE_LIMIT','AI请求过于频繁，请稍后重试',429)
        self.buckets[user_id]=(start,count+1)
        if len(self.buckets)>1000:self.buckets={k:v for k,v in self.buckets.items() if now-v[0]<300}

def stream_response(work,cleanup=lambda:None,timeout=180):
    """Queue adapter adds heartbeat without changing result/DONE semantics."""
    async def generator():
        queue=asyncio.Queue(maxsize=64)
        async def send(event):await queue.put('data: '+(event if isinstance(event,str) else dumps(event))+'\n\n')
        async def runner():
            try:
                async with asyncio.timeout(timeout):await work(send)
            except asyncio.CancelledError:raise
            except Exception as error:
                code=error.code if isinstance(error,AgentError) else 'AGENT_TIMEOUT' if isinstance(error,TimeoutError) else 'AGENT_FAILED'
                await send({'type':'error','code':code,'message':error.message if isinstance(error,AgentError) else '任务超时，请重试' if isinstance(error,TimeoutError) else '服务暂时不可用，请重试'})
            finally:
                cleanup()
                if not asyncio.current_task().cancelling():await queue.put(None)
        worker=asyncio.create_task(runner())
        try:
            while True:
                try:item=await asyncio.wait_for(queue.get(),15)
                except TimeoutError:yield ': keepalive\n\n';continue
                if item is None:break
                yield item
        finally:
            if not worker.done():worker.cancel()
            try:await worker
            except asyncio.CancelledError:pass
    return StreamingResponse(generator(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

async def persisted_work(run,store,execute,send):
    if run.get('replay') is not None:
        await send({'type':'progress','stage':'replayed','message':'已恢复保存的任务结果','runId':run['runId']})
        await send({'type':'result','result':run['replay']});await send('[DONE]');return
    async def emit(event):
        event=dict(event);checkpoint=event.pop('checkpoint',None)
        await send(await store.record(run,event,checkpoint))
    try:
        await emit({'type':'progress','stage':'started','message':'任务已开始'})
        result,metrics=await asyncio.wait_for(execute(emit),180)
        result={**result,'metrics':metrics,'runId':run['runId']}
        await emit({'type':'trace','stage':'run_completed','meta':{'metrics':metrics}})
        await store.finish(run,'succeeded',result)
        await send({'type':'result','result':result});await send('[DONE]')
    except BaseException as error:
        code='CLIENT_ABORTED' if isinstance(error,asyncio.CancelledError) and not isinstance(error,TimeoutError) else error.code if isinstance(error,AgentError) else 'AGENT_TIMEOUT' if isinstance(error,TimeoutError) else 'AGENT_FAILED'
        status='aborted' if code=='CLIENT_ABORTED' else 'timed_out' if 'TIMEOUT' in code else 'validation_error' if 'EVIDENCE' in code else 'failed'
        async def stop():
            await store.record(run,{'type':'trace','stage':'run_stopped','meta':{'code':code}})
            await store.finish(run,status,None,code)
        try:await asyncio.wait_for(asyncio.shield(asyncio.create_task(stop())),5)
        except Exception:logger.info('Run persistence stopped runId=%s code=PERSISTENCE_FAILED',run['runId'])
        raise
