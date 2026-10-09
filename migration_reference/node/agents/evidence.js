export const normalizeQuote = text => text.replace(/\s+/gu, ' ').trim()
export const EVIDENCE_FIELDS = { content: 'content', work_content: 'workContent', next_plan: 'nextPlan' }
export function checkEvidence(citation, sources, { minLength = 6 } = {}) {
  if (!citation || typeof citation !== 'object' || Array.isArray(citation) ||
    Object.keys(citation).some(key => !['reportId', 'field', 'quote'].includes(key)) ||
    !Number.isSafeInteger(citation.reportId)) throw new Error('引用格式无效')
  const field = citation.field || 'content'
  if (!Object.hasOwn(EVIDENCE_FIELDS, field)) throw new Error('引用字段无效')
  const source = sources.get(citation.reportId)
  if (!source) throw new Error('引用记录未通过工具读取')
  const text = source[EVIDENCE_FIELDS[field]] || ''
  if (typeof citation.quote !== 'string' || normalizeQuote(citation.quote).length < minLength || citation.quote.length > 400 ||
    !normalizeQuote(text).includes(normalizeQuote(citation.quote))) throw new Error('引用必须是已读取字段的连续原文片段')
  return { reportId: citation.reportId, field, quote: citation.quote.trim() }
}
