import math
import statistics

def retrieval_metrics(ranked,relevance):
    if not relevance:return {'Recall@1':None,'Recall@3':None,'Recall@5':None,'MRR':None,'nDCG@5':None,'reason':'无正例，排名指标N/A；另报告隔离/过期候选检查'}
    values={f'Recall@{k}':len(set(ranked[:k])&set(relevance))/len(relevance) for k in (1,3,5)}
    values['MRR']=next((1/(i+1) for i,id in enumerate(ranked) if id in relevance),0)
    dcg=sum((2**relevance.get(id,0)-1)/math.log2(i+2) for i,id in enumerate(ranked[:5]))
    ideal=sum((2**grade-1)/math.log2(i+2) for i,grade in enumerate(sorted(relevance.values(),reverse=True)[:5]))
    values['nDCG@5']=dcg/ideal if ideal else None
    return values

def average_metrics(rows):
    keys=['Recall@1','Recall@3','Recall@5','MRR','nDCG@5']
    return {key:statistics.mean(r[key] for r in rows if r.get(key) is not None) if any(r.get(key) is not None for r in rows) else None for key in keys}

def p95(values):
    return sorted(values)[max(0,math.ceil(len(values)*.95)-1)] if values else None
