import { ToolInputError } from './errors.js'

export function splitPlans(text) {
  return String(text || '').slice(0, 6000).split(/[\n；;]/u).map(line => line.replace(/^\s*(?:[-*]|\d+[.、)])\s*/u, '').trim())
    .filter(Boolean).slice(0, 6).map(line => line.slice(0, 400))
}

export function createPlanToolDefinitions(db) {
  return [
    {
      name: 'get_recent_plans', progress: '正在读取历史计划',
      description: '读取当前用户 next_plan，默认最近两份有计划的记录；可指定 reportId。最多六个计划，每行或分号分隔为一项，planId 由服务端生成。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        reportId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
      } },
      async execute({ reportId }, { userId, plans, planSources, signal, targetReportId }) {
        signal.throwIfAborted()
        if (plans.size) return { plans: [...plans.values()] }
        if (targetReportId && reportId && targetReportId !== reportId) throw new ToolInputError('请读取用户指定的计划来源')
        const selected = targetReportId || reportId || null
        const [rows] = await db.execute(
          `SELECT id, next_plan, created_at, updated_at FROM reports
           WHERE user_id = ? AND (? IS NULL OR id = ?) AND TRIM(COALESCE(next_plan, '')) <> ''
           ORDER BY created_at DESC, id DESC LIMIT 2`, [userId, selected, selected])
        signal.throwIfAborted()
        for (const row of rows) {
          const source = { id: Number(row.id), nextPlan: String(row.next_plan).slice(0, 6000),
            createdAt: row.created_at, updatedAt: row.updated_at }
          planSources.set(source.id, source)
          for (const [index, text] of splitPlans(source.nextPlan).entries()) {
            if (plans.size >= 6) break
            const plan = { planId: `${source.id}:${index}`, reportId: source.id, text, createdAt: source.createdAt }
            plans.set(plan.planId, plan)
          }
        }
        return { plans: [...plans.values()], timeBasis: '按创建时间与 ID 判断后续记录；未定义周报所属周期，最多六个计划' }
      }
    },
    {
      name: 'find_plan_evidence', progress: '正在查找后续证据',
      description: '查找已读取计划之后的当前用户记录，返回摘要。每个计划至少执行一次不带 keyword 的检索。可再按关键词搜索；原文引用须用 read_report 读取。没找到不能判断未完成。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        planId: { type: 'string', maxLength: 40 }, keyword: { type: 'string', maxLength: 80 },
        offset: { type: 'integer', minimum: 0, maximum: 40 }
      }, required: ['planId'] },
      async execute({ planId, keyword = '', offset = 0 }, { userId, plans, planSearches, signal }) {
        const plan = plans.get(planId)
        if (!plan) throw new ToolInputError('必须先读取该计划')
        signal.throwIfAborted()
        const [rows] = await db.execute(
          `SELECT id, content, work_content, created_at, updated_at FROM reports
           WHERE user_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
           AND (? = '' OR LOCATE(?, content) > 0 OR LOCATE(?, work_content) > 0)
           ORDER BY created_at DESC, id DESC LIMIT 7 OFFSET ?`,
          [userId, plan.createdAt, plan.createdAt, plan.reportId, keyword.trim(), keyword.trim(), keyword.trim(), offset])
        signal.throwIfAborted()
        const previous = planSearches.get(planId) || { unfiltered: false, reportIds: new Set() }
        if (!keyword.trim() && offset === 0) previous.unfiltered = true
        rows.slice(0, 6).forEach(row => previous.reportIds.add(Number(row.id)))
        planSearches.set(planId, previous)
        return { planId, reports: rows.slice(0, 6).map(row => ({ id: Number(row.id), createdAt: row.created_at,
          summary: String(row.work_content || row.content || '').slice(0, 400) })),
          hasMore: rows.length > 6, nextOffset: rows.length > 6 && offset + 6 <= 40 ? offset + 6 : null,
          notice: '仅反映本次检索范围；未提到或没有检索结果不等于未完成。' }
      }
    }
  ]
}
