from .runtime import run_agent, Limits
from .tools import build_tools
from . import prompts
from .evidence import validate_insights,validate_clarification,validate_plans

async def run_task(task,input,user_id,db,provider,retrieval,emit,limits=Limits()):
    context={'userId':user_id,'sources':{},'input':input,'plans':{},'planSources':{},'planSearches':{},'plansLoaded':False,'targetReportId':input.get('reportId')}
    if task=='insights':system=prompts.INSIGHTS;query=input.get('question') or '请基于历史周报复盘工作主线、连续性、反复问题和下一步建议，附真实原文依据。';validate=validate_insights
    elif task=='plans':system=prompts.PLANS;query=f"分析周报#{input['reportId']}的计划后续状态" if input.get('reportId') else '分析最近保存的计划及后续状态';validate=validate_plans
    else:system=prompts.CLARIFICATION;query=__import__('json').dumps(input,ensure_ascii=False);validate=validate_clarification
    registry=build_tools(db,retrieval,plans=task=='plans',enabled=task!='clarification' or input['useHistory'])
    return await run_agent(messages=[{'role':'system','content':system},{'role':'user','content':query}],registry=registry,complete=provider.complete,context=context,validate=validate,emit=emit,limits=limits)
