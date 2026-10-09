import { checkEvidence } from './evidence.js'

export const INSIGHT_SECTIONS = Object.freeze([
  { key: 'workstreams', title: '近期工作主线' },
  { key: 'continuity', title: '连续性与推进情况' },
  { key: 'recurringProblems', title: '可能的反复问题' },
  { key: 'suggestions', title: '下一步建议' }
])

export const TIME_LIMITATION = '本次按记录创建时间检索；创建时间不代表周报所属周期，同一周期可能有多份记录，不能据此认定跨周或连续多周。'

// Checks provenance, not semantic entailment. The UI exposes quotes for human review.
export function validateInsightsResult(content, { sources }) {
  try {
    if (typeof content !== 'string' || content.length > 20000) throw new Error('最终结果必须是有效 JSON，且长度不超过 20000 字')
    const result = JSON.parse(content)
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).some((key) => !INSIGHT_SECTIONS.some((section) => section.key === key))) {
      throw new Error('只能输出规定的四个分析字段')
    }
    if (sources.size < 2) throw new Error('必须通过 read_report 读取至少两份不同周报后再分析')
    const used = new Set()
    let itemCount = 0
    const sections = INSIGHT_SECTIONS.map(({ key, title }) => {
      const items = result[key]
      if (!Array.isArray(items) || items.length > 4) throw new Error(`${key} 必须是最多 4 条的数组；无证据时返回空数组`)
      const checkedItems = items.map((item) => {
        if (!item || typeof item !== 'object' || Object.keys(item).some((key) => !['text', 'evidence'].includes(key)) ||
          typeof item.text !== 'string' || !item.text.trim() || item.text.length > 800) throw new Error('每条结论必须有 1 到 800 字的 text')
        if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 4) throw new Error('每条结论必须有 1 到 4 条 evidence')
        const evidence = item.evidence.map((citation) => {
          if (!citation || typeof citation !== 'object' || Object.keys(citation).some((key) => !['reportId', 'quote'].includes(key)) ||
            !Number.isSafeInteger(citation.reportId)) throw new Error('引用必须包含整数 reportId 和原文 quote')
          const source = sources.get(citation.reportId)
          if (!source) throw new Error(`周报 #${citation.reportId} 未通过工具读取，不能引用`)
          try { checkEvidence(citation, sources) }
          catch { throw new Error(`周报 #${citation.reportId} 的 quote 必须是已读取原文中的连续片段（6 到 400 字）`) }
          used.add(citation.reportId)
          return { reportId: citation.reportId, quote: citation.quote.trim() }
        })
        if (['continuity', 'recurringProblems'].includes(key) && new Set(evidence.map((entry) => entry.reportId)).size < 2) {
          throw new Error(`${key} 的每条结论必须引用至少两份不同记录，不能根据单份周报推断连续性或反复问题`)
        }
        itemCount++
        return { text: item.text.trim(), evidence }
      })
      return { key, title, items: checkedItems }
    })
    if (itemCount && used.size < 2) throw new Error('有结论的分析结果必须引用至少两份不同周报；完全没有充分证据时四个数组都应为空')
    return {
      ok: true,
      value: { sections, sources: [...sources.values()],
        limitations: [TIME_LIMITATION, ...(itemCount ? [] : ['已读取的周报缺少足够信息，本次不生成推测性结论。']), ...([...sources.values()].some((source) => source.truncated)
          ? ['部分正文超过 6000 字，仅分析工具实际返回的片段；未读取内容不属于本次证据。'] : [])] }
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}
