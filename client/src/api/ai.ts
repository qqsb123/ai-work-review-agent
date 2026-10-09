import { streamPost } from './sse'

export type RewriteMode = 'professional' | 'concise' | 'okr'

export interface AgentProgress { stage: string; message: string }
export interface ReportSource { id: number; createdAt: string; updatedAt: string; content?: string; workContent?: string; nextPlan?: string; truncated?: boolean }
export interface ReportEvidence { reportId: number; field?: 'content' | 'work_content' | 'next_plan'; quote: string }
export type PlanStatus = 'completed' | 'in_progress' | 'blocked' | 'unconfirmed'
export interface PlanResult {
  plans: Array<{ planId: string; reportId: number; text: string; status: PlanStatus; reason: string; evidence: ReportEvidence[]; reviewedReportIds: number[] }>
  sources: ReportSource[]
  limitations: string[]
  runId: string
}

export interface InsightsResult {
  sections: Array<{
    key: string
    title: string
    items: Array<{ text: string; evidence: Array<{ reportId: number; quote: string }> }>
  }>
  sources: Array<{ id: number; createdAt: string; updatedAt: string; content: string; truncated: boolean }>
  limitations: string[]
  metrics: { steps: number; toolCalls: number; totalTokens: number; usageEstimated: boolean; repairs: number; durationMs: number }
  runId: string
}

export function trackPlans(reportId: number | undefined, onResult: (result: PlanResult) => void,
  onProgress: (event: AgentProgress) => void, onDone: () => void, onError: (message: string) => void, signal: AbortSignal) {
  return streamPost('/api/ai/plans', { reportId }, { onContent: () => {}, onResult, onProgress, onDone, onError, requireResult: true }, signal)
}

export function rewriteReport(
  reportId: number,
  content: string,
  mode: RewriteMode,
  onContent: (content: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
  signal: AbortSignal
) {
  return streamPost(
    `/api/ai/rewrite/${reportId}`,
    { content, mode },
    { onContent, onDone, onError },
    signal
  )
}

export function generateInsights(
  question: string,
  onResult: (result: InsightsResult) => void,
  onProgress: (event: { stage: string; message: string }) => void,
  onDone: () => void,
  onError: (message: string) => void,
  signal: AbortSignal
) {
  return streamPost(
    '/api/ai/insights',
    { question },
    { onContent: () => {}, onResult, onProgress, onDone, onError, requireResult: true },
    signal
  )
}
