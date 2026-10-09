export class AgentError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentError'
    this.code = code
  }
}

export class ToolInputError extends AgentError {
  constructor(message) {
    super('TOOL_INPUT_INVALID', message)
  }
}
