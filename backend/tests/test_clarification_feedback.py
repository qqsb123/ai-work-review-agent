import json
import pytest
from app.evidence import validate_clarification

def test_problem_question_must_anchor_to_work_when_optional_fields_empty():
    ctx={'input':{'work':'做了权限模块，解决了一些问题。','problems':'','nextPlan':''},'sources':{}}
    q={'id':'q1','field':'problems','kind':'problem','anchor':'解决了一些问题','question':'具体解决了什么问题，目前处理情况如何？'}
    with pytest.raises(ValueError,match='field表示来源'):validate_clarification(json.dumps({'questions':[q]}),ctx)
    q['field']='work'
    assert validate_clarification(json.dumps({'questions':[q]}),ctx)['questions'][0]['field']=='work'
