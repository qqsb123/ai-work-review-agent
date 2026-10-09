export function normalizeWeeklyInput(body) {
  const result = { work: body.work, problems: body.problems ?? '', nextPlan: body.nextPlan ?? '',
    style: body.style ?? 'detailed', useHistory: body.useHistory ?? false }
  for (const [key, limit] of [['work', 6000], ['problems', 4000], ['nextPlan', 4000]]) {
    if (typeof result[key] !== 'string' || result[key].length > limit) throw new Error(`${key} 必须是长度不超过 ${limit} 的文字`)
    result[key] = result[key].trim()
  }
  if (!result.work) throw new Error('本周工作内容不能为空')
  if (!['concise', 'detailed', 'okr'].includes(result.style)) throw new Error('无效的周报风格')
  if (typeof result.useHistory !== 'boolean') throw new Error('useHistory 必须是布尔值')
  return result
}
