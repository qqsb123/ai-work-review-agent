import math
import pytest
from eval.metrics import retrieval_metrics,average_metrics,p95

def test_metrics_hand_computed_and_na_conditions():
    result=retrieval_metrics([9,2,1],{1:3,2:2})
    assert result['Recall@1']==0 and result['Recall@3']==1 and result['Recall@5']==1
    assert result['MRR']==.5
    assert result['nDCG@5']==pytest.approx((3/math.log2(3)+7/math.log2(4))/(7+3/math.log2(3)))
    assert retrieval_metrics([1],{})['MRR'] is None
    assert average_metrics([result,retrieval_metrics([],{})])['MRR']==.5
    assert p95([1,2,3,4,5])==5 and p95([]) is None
