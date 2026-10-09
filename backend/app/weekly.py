import re
from .errors import AgentError

def continue_draft(draft,body):
    if draft['state']!='prepared':raise AgentError('DRAFT_STATE','草稿已生成或正在处理',409)
    answers=body.get('answers',[]);skip=body.get('skipClarification',False)
    if not isinstance(answers,list) or len(answers)>3 or type(skip) is not bool:raise AgentError('DRAFT_INPUT','补充信息格式错误')
    seen=set();known={q['id'] for q in draft['questions']}
    for answer in answers:
        if not isinstance(answer,dict) or set(answer)!={'questionId','value'} or answer['questionId'] not in known or answer['questionId'] in seen or not isinstance(answer['value'],str) or len(answer['value'])>1000:
            raise AgentError('DRAFT_INPUT','补充信息必须关联本次追问')
        seen.add(answer['questionId'])
    input=dict(draft['input']);unknown=[]
    for q in draft['questions']:
        value='' if skip else next((a['value'].strip() for a in answers if a['questionId']==q['id']),'')
        if value:input[q['field']]+=f"\n补充事实（{q['anchor']}）：{value}"
        else:unknown.append(q)
    draft.update(generationInput=input,unanswered=unknown)

def validate_draft(content,draft):
    if not isinstance(content,str) or not content.strip() or len(content)>20000:raise AgentError('DRAFT_INVALID','生成内容为空或过长')
    input=draft.get('generationInput',draft['input']);facts='\n'.join(input[k] for k in ('work','problems','nextPlan'))
    allowed=set(re.findall(r'\d+(?:\.\d+)?%?',facts))
    stripped=re.sub(r'^(?:#{1,6}\s*)?\s*\d+[.)、]\s*','',content,flags=re.M)
    stripped=re.sub(r'\b(?:KR|Objective|O)\s*\d+\b','',stripped,flags=re.I)
    if any(n not in allowed for n in re.findall(r'\d+(?:\.\d+)?%?',stripped)):raise AgentError('DRAFT_FACT_INVALID','草稿出现未提供数字')
    def completed(text):
        return any(not re.search('计划|预计|准备|尚未|没有|未完成|是否|无法确认|未明确|不确定|待确认',line) and re.search('已完成|已经完成|完成了|开发完成|已上线|已交付|完成.{0,12}(?:模块|接口|功能)',line) for line in re.split('[。\n]',text))
    unknown=draft.get('unanswered',[])
    work_section=re.split(r'#{1,6}\s*(?:下周|下一步|后续)',content)[0]
    if any(q['field']=='work' and q['kind']=='status' for q in unknown) and not completed(input['work']) and completed(work_section):raise AgentError('DRAFT_FACT_INVALID','未确认状态不能变成完成事实')
    return content.strip()+('\n\n## 待确认信息\n'+'\n'.join(f"- {q['question']}：未提供补充信息，无法确认。" for q in unknown) if unknown else '')

def conservative(draft):
    input=draft.get('generationInput',draft['input'])
    return validate_draft(f"## 本周工作总结\n{input['work']}\n\n## 问题与改进\n{input['problems'] or '未提供问题细节，暂不补充事实。'}\n\n## 下周计划\n{input['nextPlan'] or '未提供具体计划，待确认。'}",draft)
