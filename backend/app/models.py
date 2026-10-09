from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr
from .errors import AgentError

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class WeeklyInput(StrictModel):
    work: StrictStr = Field(max_length=6000)
    problems: StrictStr = Field(default='', max_length=4000)
    nextPlan: StrictStr = Field(default='', max_length=4000)
    style: Literal['concise', 'detailed', 'okr'] = 'detailed'
    useHistory: StrictBool = False

def normalize_input(body):
    # Request identity belongs to HTTP infrastructure, never model tool input.
    values = {k: body[k] for k in ('work','problems','nextPlan','style','useHistory') if k in body}
    try:
        result = WeeklyInput.model_validate(values).model_dump()
    except ValueError:
        raise AgentError('DRAFT_INPUT', '周报字段类型、长度或风格无效') from None
    for field in ('work','problems','nextPlan'):
        result[field] = result[field].strip()
    if not result['work']:
        raise AgentError('DRAFT_INPUT','本周工作内容不能为空')
    return result

class LoginInput(StrictModel):
    username: StrictStr = Field(min_length=1, max_length=64)
    password: StrictStr = Field(min_length=1, max_length=1024)

class ConfirmInput(StrictModel):
    sessionId: StrictStr = Field(min_length=36, max_length=36)
    content: StrictStr = Field(min_length=1, max_length=24000)
    confirm: StrictBool
