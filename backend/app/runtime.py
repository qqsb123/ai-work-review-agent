import asyncio
import json
import time
from dataclasses import dataclass, asdict
from .errors import AgentError, ToolInputError

@dataclass(frozen=True)
class Limits:
    maxSteps:int=8
    maxToolCalls:int=12
    maxToolCallsPerStep:int=6
    maxOutputTokens:int=3000
    maxTotalTokens:int=80000
    maxContextChars:int=50000
    maxFinalRepairs:int=2
    timeoutMs:int=180000

def dumps(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'),default=str)

def argument_summary(call):
    try:
        args=json.loads(call.get('function',{}).get('arguments','{}'))
        return {key:({'type':'text','chars':len(v)} if isinstance(v,str) else v if type(v) is int else {'type':type(v).__name__})
            for key,v in args.items() if key in ('query','keyword','limit','offset','reportId','planId')}
    except (ValueError,AttributeError): return {'invalidJson':True}

def result_summary(result):
    summary={}
    if isinstance(result.get('reports'),list): summary.update(count=len(result['reports']),reportIds=[r['id'] for r in result['reports']][:10])
    if result.get('id'): summary.update(reportId=result['id'],chars=len(result.get('content','')))
    if isinstance(result.get('plans'),list): summary['count']=len(result['plans'])
    if result.get('retrieval'): summary['retrieval']=result['retrieval']
    if result.get('error'): summary['errorCode']='TOOL_INPUT_INVALID'
    return summary

async def run_agent(*, messages, registry, complete, context, validate, emit, limits=Limits()):
    """Only runtime. Tasks supply system/input, tools, context and validator."""
    messages=[dict(m) for m in messages]
    stats={'steps':0,'toolCalls':0,'totalTokens':0,'usageEstimated':False,'repairs':0,'embeddingTokens':0,'rerankTokens':0}
    started=time.monotonic(); ids=set()
    context['retrievalBudget']={'remaining':0,'pending':0,'embeddingTokens':0,'rerankTokens':0,'documents':0,'estimated':False}
    async def trace(stage,**meta):
        await emit({'type':'trace','stage':stage,'meta':meta,'elapsedMs':round((time.monotonic()-started)*1000),
            'checkpoint':{'boundary':stage,'stats':dict(stats),'sourceIds':list(context['sources']),'recovery':'restart_from_input'}})
    async def charge_retrieval():
        budget=context['retrievalBudget']
        stats['totalTokens']+=budget['pending']; stats['embeddingTokens']+=budget['embeddingTokens']; stats['rerankTokens']+=budget['rerankTokens']
        stats['usageEstimated'] |= budget['estimated']
        for key in ('pending','embeddingTokens','rerankTokens'): budget[key]=0
        if stats['totalTokens']>limits.maxTotalTokens: raise AgentError('AGENT_TOKEN_LIMIT','检索与模型总用量达到上限')
    try:
        async with asyncio.timeout(limits.timeoutMs/1000):
            await trace('run_started',budget=asdict(limits))
            for step in range(1,limits.maxSteps+1):
                serialized=dumps({'messages':messages,'tools':registry.schemas})
                if len(serialized)>limits.maxContextChars: raise AgentError('AGENT_CONTEXT_LIMIT','分析上下文达到上限')
                reserve=len(serialized.encode()); remaining=limits.maxTotalTokens-stats['totalTokens']-reserve
                if remaining<256: raise AgentError('AGENT_TOKEN_LIMIT','分析用量达到上限')
                max_tokens=min(limits.maxOutputTokens,remaining); stats['steps']=step
                context['retrievalBudget']['remaining']=remaining-max_tokens
                await emit({'type':'progress','stage':'thinking','message':context.get('thinking','正在分析已有证据')})
                round_started=time.monotonic()
                await trace('model_start',step=step,maxTokens=max_tokens,contextChars=len(serialized),remainingTokens=remaining)
                response=await complete(messages=messages,tools=registry.schemas,max_tokens=max_tokens)
                usage=response.get('usage') or {}; total=usage.get('total_tokens')
                if type(total) is int and total>0: stats['totalTokens']+=total
                else: stats['totalTokens']+=reserve+max_tokens; stats['usageEstimated']=True
                if stats['totalTokens']>limits.maxTotalTokens: raise AgentError('AGENT_TOKEN_LIMIT','模型用量达到上限')
                message=response.get('message'); reason=response.get('finishReason')
                if not isinstance(message,dict) or message.get('role')!='assistant' or reason not in ('stop','tool_calls'):
                    raise AgentError('AGENT_RESPONSE_INCOMPLETE','模型响应未完整结束')
                calls=message.get('tool_calls') or []
                if not isinstance(calls,list) or bool(calls)!=(reason=='tool_calls'): raise AgentError('AGENT_RESPONSE_INVALID','工具调用与结束状态不一致')
                await trace('model_end',step=step,finishReason=reason,toolCount=len(calls),tokens=total,totalTokens=stats['totalTokens'],usageEstimated=stats['usageEstimated'],durationMs=round((time.monotonic()-round_started)*1000))
                if calls:
                    if len(calls)>limits.maxToolCallsPerStep or stats['toolCalls']+len(calls)>limits.maxToolCalls: raise AgentError('AGENT_TOOL_LIMIT','工具调用达到上限')
                    for call in calls:
                        cid=call.get('id') if isinstance(call,dict) else None
                        if not isinstance(cid,str) or not 1<=len(cid)<=200 or cid in ids: raise AgentError('AGENT_RESPONSE_INVALID','工具调用标识无效或重复')
                        ids.add(cid)
                    # Complete assistant is retained only in this run, never Trace/Checkpoint.
                    messages.append(message)
                    for call in calls:
                        stats['toolCalls']+=1; name=call.get('function',{}).get('name'); safe_name=registry.safe_name(name)
                        await emit({'type':'progress','stage':'tool','message':registry.progress(name)})
                        tool_started=time.monotonic()
                        await trace('tool_start',step=step,tool=safe_name,callId=call['id'],arguments=argument_summary(call))
                        try: result=await registry.execute(call,context)
                        except ToolInputError as error:
                            result={'error':{'code':error.code,'message':error.message}}
                            await trace('tool_validation_error',step=step,code=error.code)
                        payload={**result,'_runtimeBudget':{'remainingRounds':limits.maxSteps-step,'remainingToolCalls':limits.maxToolCalls-stats['toolCalls']}}
                        messages.append({'role':'tool','tool_call_id':call['id'],'content':dumps(payload)})
                        await charge_retrieval()
                        await trace('tool_end',step=step,tool=safe_name,callId=call['id'],result=result_summary(result),durationMs=round((time.monotonic()-tool_started)*1000))
                    continue
                await emit({'type':'progress','stage':'validating','message':'正在核对结论引用的原文证据'})
                try:
                    if not isinstance(message.get('content'),str) or len(message['content'])>20000: raise ValueError('输出必须为有界JSON')
                    result=validate(message['content'],context)
                except (ValueError,KeyError,TypeError,AttributeError) as error:
                    await trace('validation_error',step=step,code='AGENT_EVIDENCE_INVALID',repairs=stats['repairs'])
                    if stats['repairs']>=limits.maxFinalRepairs: raise AgentError('AGENT_EVIDENCE_INVALID','结果未通过证据校验') from None
                    stats['repairs']+=1
                    issue=str(error)[:300] if isinstance(error,ValueError) else '规定JSON结构或字段类型无效'
                    messages.extend([message,{'role':'user','content':'最终JSON或证据未通过服务端校验。必须按规定结构，引用本次工具实际读取的连续原文；计划无明确状态则unconfirmed。请修正，必要时继续工具调用。校验问题：'+issue}])
                    await emit({'type':'progress','stage':'repairing','message':'正在修正未通过校验的引用'})
                    continue
                await trace('validation_passed',step=step)
                stats['durationMs']=round((time.monotonic()-started)*1000)
                return result,stats
            raise AgentError('AGENT_STEP_LIMIT','分析轮次达到上限')
    except TimeoutError: raise AgentError('AGENT_TIMEOUT','分析超时，请重试') from None
