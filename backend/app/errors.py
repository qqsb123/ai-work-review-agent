class AgentError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)

class ToolInputError(AgentError):
    def __init__(self, message='工具参数无效'):
        super().__init__('TOOL_INPUT_INVALID', message)
