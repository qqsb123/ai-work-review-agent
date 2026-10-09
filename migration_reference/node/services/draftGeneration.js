import { AgentError } from '../agents/errors.js'

export function continueDraft(draft, body) {
  if (draft.state !== 'prepared') throw new AgentError('DRAFT_STATE', '该草稿已生成或正在处理，请重新开始')
  const answers = body.answers ?? []
  if (!Array.isArray(answers) || answers.length > 3 || typeof (body.skipClarification ?? false) !== 'boolean') throw new AgentError('DRAFT_INPUT', '补充信息格式无效')
  const seen = new Set()
  for (const answer of answers) {
    if (!answer || Object.keys(answer).some(key => !['questionId', 'value'].includes(key)) ||
      !draft.questions.some(question => question.id === answer.questionId) || seen.has(answer.questionId) ||
      typeof answer.value !== 'string' || answer.value.length > 1000) throw new AgentError('DRAFT_INPUT', '补充信息必须对应本次追问，且不超过 1000 字')
    seen.add(answer.questionId)
  }
  const input = { ...draft.input }
  const unanswered = []
  for (const question of draft.questions) {
    const value = body.skipClarification ? '' : answers.find(answer => answer.questionId === question.id)?.value.trim() || ''
    if (value) input[question.field] += `\n补充事实（${question.anchor}）：${value}`
    else unanswered.push(question)
  }
  draft.generationInput = input
  draft.unanswered = unanswered
  return { input, unanswered }
}

export function validateGeneratedDraft(content, draft) {
  if (!content.trim() || content.length > 20000) throw new AgentError('DRAFT_INVALID', '生成内容为空或过长，请重试')
  const input = draft.generationInput || draft.input
  const facts = `${input.work}\n${input.problems}\n${input.nextPlan}`
  const numericValues = text => text.match(/\d+(?:\.\d+)?%?/gu) || []
  const allowed = new Set(numericValues(facts))
  const withoutLabels = content.replace(/^(?:#{1,6}\s*)?\s*\d+[.)、]\s*/gmu, '').replace(/\b(?:KR|Objective|O)\s*\d+\b/giu, '')
  if (numericValues(withoutLabels).some(value => !allowed.has(value))) throw new AgentError('DRAFT_FACT_INVALID', '草稿出现输入未提供的数字，请重新生成或补充信息')
  // Do not allow a skipped, ambiguous completion status to become a completed claim.
  const unknownStatus = draft.unanswered?.some(question => question.field === 'work' && question.kind === 'status')
  const hasCompletedClaim = text => text.split(/[。\n]/u).some(line =>
    !/(?:计划|预计|准备|尚未|没有|未完成|是否|无法确认|未明确|不确定|待确认)/u.test(line) &&
    /(?:已完成|已经完成|完成了|开发完成|已上线|已交付|完成.{0,12}(?:模块|接口|功能))/u.test(line))
  const workSection = content.split(/#{1,6}\s*(?:下周|下一步|后续)/u)[0]
  if (unknownStatus && !hasCompletedClaim(input.work) && hasCompletedClaim(workSection)) {
    throw new AgentError('DRAFT_FACT_INVALID', '未确认的工作状态不能被写成已完成，请补充或重新生成')
  }
  const unknowns = (draft.unanswered || []).map(question => `- ${question.question}：未提供补充信息，无法确认。`)
  return content.trim() + (unknowns.length ? `\n\n## 待确认信息\n${unknowns.join('\n')}` : '')
}

// Deterministic recovery never adds facts or makes another paid model call.
export function conservativeDraft(draft) {
  const input = draft.generationInput || draft.input
  return validateGeneratedDraft(`## 本周工作总结\n${input.work}\n\n## 问题与改进\n${input.problems || '未提供问题细节，暂不补充事实。'}\n\n## 下周计划\n${input.nextPlan || '未提供具体计划，待确认。'}`, draft)
}
