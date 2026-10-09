import { ToolInputError } from './errors.js'

// The schema advertised to the model is also enforced locally. No model-provided
// arguments (including userId) bypass this boundary.
function validateArguments(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError('工具参数必须是 JSON 对象')
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, key)) throw new ToolInputError(`不允许参数：${key}`)
  }
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) throw new ToolInputError(`缺少参数：${key}`)
  }
  for (const [key, input] of Object.entries(value)) {
    const rule = schema.properties[key]
    if (rule.type === 'string') {
      if (typeof input !== 'string' || input.length > rule.maxLength) {
        throw new ToolInputError(`${key} 必须是长度不超过 ${rule.maxLength} 的字符串`)
      }
    } else if (rule.type === 'integer') {
      if (!Number.isSafeInteger(input) || input < rule.minimum || input > rule.maximum) {
        throw new ToolInputError(`${key} 必须是 ${rule.minimum} 到 ${rule.maximum} 之间的整数`)
      }
    } else {
      throw new ToolInputError(`不支持的参数类型：${key}`)
    }
  }
}

export function createToolRegistry(definitions) {
  const entries = new Map(definitions.map((tool) => [tool.name, tool]))
  if (entries.size !== definitions.length) throw new Error('工具名称不能重复')
  return {
    schemas: definitions.map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters }
    })),
    getProgress: name => entries.get(name)?.progress || '正在处理工具请求',
    getSafeName: name => entries.has(name) ? name : 'unknown_tool',
    async execute(call, context) {
      const tool = entries.get(call.function?.name)
      if (!tool || call.type !== 'function') throw new ToolInputError('不支持的工具')
      let args
      try {
        const raw = call.function.arguments
        if (typeof raw !== 'string' || raw.length > (tool.maxArgumentsChars || 2000)) throw new Error('invalid arguments')
        args = JSON.parse(raw)
      } catch {
        throw new ToolInputError('工具参数不是有效的 JSON，或参数过长')
      }
      validateArguments(args, tool.parameters)
      context.signal.throwIfAborted()
      return tool.execute(args, context)
    }
  }
}
