import json
import re
from datetime import datetime

TIME_LIMITATION = '本次按记录创建时间检索；创建时间不代表周报所属周期，同一周期可能有多份记录，不能据此认定跨周或连续多周。'
FIELDS = {'content':'content','work_content':'workContent','next_plan':'nextPlan'}
SECTIONS = [('workstreams','近期工作主线'),('continuity','连续性与推进情况'),('recurringProblems','可能的反复问题'),('suggestions','下一步建议')]
normalize = lambda text: re.sub(r'\s+', ' ', text).strip()

def check_evidence(citation, sources):
    if not isinstance(citation,dict) or set(citation)-{'reportId','field','quote'} or type(citation.get('reportId')) is not int:
        raise ValueError('引用格式无效')
    field = citation.get('field','content')
    if field not in FIELDS or citation['reportId'] not in sources:
        raise ValueError('引用字段无效或记录未通过工具读取')
    quote = citation.get('quote')
    text = sources[citation['reportId']].get(FIELDS[field], '')
    if not isinstance(quote,str) or not 6 <= len(normalize(quote)) or len(quote)>400 or normalize(quote) not in normalize(text):
        raise ValueError('引用必须是已读取字段的连续原文片段')
    return {'reportId':citation['reportId'],'field':field,'quote':quote.strip()}

def validate_insights(content, ctx):
    data=json.loads(content)
    sources=ctx['sources']
    if not isinstance(data,dict) or set(data)!={k for k,_ in SECTIONS} or len(sources)<2:
        raise ValueError('必须输出四数组，且实际读取至少两份不同原文')
    sections=[]; used=set(); count=0
    for key,title in SECTIONS:
        if not isinstance(data[key],list) or len(data[key])>4: raise ValueError('分析条目过多或格式错误')
        items=[]
        for item in data[key]:
            if not isinstance(item,dict) or set(item)!={'text','evidence'} or not isinstance(item['text'],str) or not 1<=len(item['text'].strip())<=800:
                raise ValueError('结论格式错误')
            if not isinstance(item['evidence'],list) or not 1<=len(item['evidence'])<=4: raise ValueError('引用数量无效')
            citations=[]
            for citation in item['evidence']:
                if not isinstance(citation,dict) or set(citation)!={'reportId','quote'}: raise ValueError('洞察引用字段无效')
                checked=check_evidence(citation,sources); used.add(checked['reportId'])
                citations.append({'reportId':checked['reportId'],'quote':checked['quote']})
            if key in ('continuity','recurringProblems') and len({c['reportId'] for c in citations})<2:
                raise ValueError('连续性和反复问题必须有两份来源')
            items.append({'text':item['text'].strip(),'evidence':citations}); count+=1
        sections.append({'key':key,'title':title,'items':items})
    if count and len(used)<2: raise ValueError('非空结果须引用两份原文')
    return {'sections':sections,'sources':list(sources.values()),'limitations':[TIME_LIMITATION]+([] if count else ['已读取记录不足，本次不推测。'])}

def validate_clarification(content,ctx):
    data=json.loads(content)
    if not isinstance(data,dict) or set(data)!={'questions'} or not isinstance(data['questions'],list) or len(data['questions'])>3:
        raise ValueError('追问格式错误')
    seen=set()
    for i,q in enumerate(data['questions']):
        if not isinstance(q,dict) or set(q)!={'id','field','kind','anchor','question'} or q['id']!=f'q{i+1}' or q['field'] not in ('work','problems','nextPlan') or q['kind'] not in ('status','details','problem','plan'):
            raise ValueError('问题格式或字段错误')
        if not isinstance(q['anchor'],str) or not 2<=len(q['anchor'].strip())<=200 or q['anchor'] not in ctx['input'][q['field']]:
            raise ValueError(f"{q['id']}的anchor必须来自声明field={q['field']}对应的非空原始字段；field表示来源而非问题类别。work里的问题线索也必须field=work；空problems/nextPlan不能追问")
        if not isinstance(q['question'],str) or not 8<=len(q['question'])<=120 or re.search('[<>]',q['question']): raise ValueError('问题文本错误')
        key=(q['field'],q['kind'],q['anchor'])
        if key in seen: raise ValueError('重复追问')
        seen.add(key)
    return {'questions':data['questions'],'historySources':list(ctx['sources'].values())}

def supports_status(plan,quote,status):
    topic=re.sub(r'^(?:(?:计划|下周|继续|完成|开发|实现|推进|优化|补充|学习|研究|完善|修复|解决|进行|开展|的|：)|\s)+','',plan)
    topic=re.split('[，,。；;和与]|并',topic)[0].strip()
    if len(topic)<2 or topic not in quote or re.search('下周|计划|预计|准备|将要|尚未|没有|未能|未完成|待完成|不确定',quote): return False
    cues={'completed':'已完成|开发完成|完成了|已上线|已验收|已交付|已经完成|完成并','in_progress':'进行中|正在|开发中|持续推进|已开始|联调中','blocked':'阻塞|卡住|无法推进|被阻挡|受阻'}
    return bool(re.search(cues.get(status,r'(?!)'),quote))

def validate_plans(content,ctx):
    data=json.loads(content)
    if not isinstance(data,dict) or set(data)!={'plans'} or not isinstance(data['plans'],list) or len(data['plans'])!=len(ctx['plans']) or not ctx['plansLoaded']:
        raise ValueError('必须读取并返回全部计划')
    items=[]; seen=set()
    for item in data['plans']:
        if not isinstance(item,dict) or set(item)!={'planId','status','evidence'} or item['status'] not in ('completed','in_progress','blocked','unconfirmed') or not isinstance(item['evidence'],list) or len(item['evidence'])>3:
            raise ValueError('计划状态格式错误')
        plan=ctx['plans'].get(item['planId']); search=ctx['planSearches'].get(item['planId'])
        if not plan or item['planId'] in seen or not search or not search['unfiltered']: raise ValueError('计划缺失、重复或未检索后续记录')
        seen.add(item['planId']); citations=[]
        for entry in item['evidence']:
            checked=check_evidence(entry,ctx['sources']); source=ctx['sources'][checked['reportId']]
            if checked['field'] not in ('content','work_content') or checked['reportId'] not in search['reportIds']:
                raise ValueError('引用不是该计划检索到的后续正文')
            if (str(source['createdAt']),source['id']) <= (str(plan['createdAt']),plan['reportId']): raise ValueError('引用不是后续记录')
            citations.append(checked)
        if item['status']!='unconfirmed' and not any(supports_status(plan['text'],c['quote'],item['status']) for c in citations):
            raise ValueError('没有明确同一事项状态证据，应返回unconfirmed')
        items.append({**plan,'status':item['status'],'reason':'当前已检索记录不足，无法确认。没有提到不代表未完成。' if item['status']=='unconfirmed' else '后续记录包含对应事项的明确状态表述，请结合原文确认。',
            'evidence':[{'reportId':plan['reportId'],'field':'next_plan','quote':plan['text']},*citations], 'reviewedReportIds':sorted(search['reportIds'])})
    sources={**ctx['planSources'],**ctx['sources']}
    return {'plans':items,'sources':list(sources.values()),'limitations':[TIME_LIMITATION,'状态是只读建议，不写回正式数据；原计划不证明已完成。']}
