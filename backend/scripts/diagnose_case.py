"""Synthetic-only validator diagnostics; never imports production user data."""
import asyncio
import json
from app.runtime import run_agent
from app.tools import build_tools
from app.provider import DeepSeek
from app.evidence import validate_clarification,validate_plans
from app import prompts
from tests.helpers import MemoryDB,DummyRag,noop
from eval.dataset import AGENT_CASES,records

async def main():
    provider=DeepSeek();issues=[]
    try:
        for name in ('ambiguous','plan'):
            case=next(c for c in AGENT_CASES if c['id']==name);input=case['input']
            context={'userId':7,'sources':{},'input':input,'plans':{},'planSources':{},'planSearches':{},'plansLoaded':False,'targetReportId':input.get('reportId')}
            validator=validate_clarification if name=='ambiguous' else validate_plans
            def validate(content,ctx):
                try:return validator(content,ctx)
                except (ValueError,KeyError,TypeError) as error:
                    issues.append({'case':name,'validation':str(error),'syntheticPublicOutput':json.loads(content)})
                    raise
            messages=[{'role':'system','content':prompts.CLARIFICATION if name=='ambiguous' else prompts.PLANS},
                {'role':'user','content':json.dumps(input,ensure_ascii=False) if name=='ambiguous' else '分析周报#1计划后续状态'}]
            try:
                result,metrics=await run_agent(messages=messages,registry=build_tools(MemoryDB(records()),DummyRag(),plans=name=='plan',enabled=name=='plan'),complete=provider.complete,
                    context=context,validate=validate,emit=noop)
                issues.append({'case':name,'finalSyntheticResult':result,'metrics':metrics})
            except Exception as error:issues.append({'case':name,'failure':getattr(error,'code','FAILED')})
    finally:await provider.close()
    print(json.dumps(issues,ensure_ascii=True,indent=2))

if __name__=='__main__':asyncio.run(main())
