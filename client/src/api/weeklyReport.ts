import { streamPost } from './sse'
import type { AgentProgress } from './ai'

export interface WeeklyReportPayload {
  work: string
  problems: string
  nextPlan: string
  style: 'concise' | 'detailed' | 'okr'
  useHistory: boolean
}

export interface ClarificationQuestion {
  id: string
  field: 'work' | 'problems' | 'nextPlan'
  kind: 'status' | 'details' | 'problem' | 'plan'
  anchor: string
  question: string
}
export interface PreparedDraft { sessionId: string; questions: ClarificationQuestion[]; expiresAt: number }
export interface GeneratedDraft { sessionId: string; content: string; requiresConfirmation: boolean; factCheckFallback?: boolean }
export interface DraftContinuation { sessionId: string; answers: Array<{ questionId: string; value: string }>; skipClarification: boolean }

export function prepareWeeklyReport(payload: WeeklyReportPayload, onResult: (result: PreparedDraft) => void,
  onProgress: (event: AgentProgress) => void, onError: (message: string) => void, signal: AbortSignal) {
  return streamPost('/api/weekly-report/prepare', payload,
    { onContent: () => {}, onResult, onProgress, onDone: () => {}, onError, requireResult: true }, signal)
}

export function generatePreparedReport(payload: DraftContinuation, onContent: (content: string) => void,
  onResult: (result: GeneratedDraft) => void, onError: (message: string) => void, signal: AbortSignal) {
  return streamPost('/api/weekly-report', payload,
    { onContent, onResult, onDone: () => {}, onError, requireResult: true }, signal)
}

export async function confirmWeeklyReport(draft: GeneratedDraft): Promise<{ reportId: number; alreadySaved: boolean }> {
  const response = await fetch('/api/weekly-report/confirm', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
    body: JSON.stringify({ sessionId: draft.sessionId, content: draft.content, confirm: true }) })
  const result = await response.json().catch(() => ({}))
  if (response.status === 401) {
    localStorage.removeItem('token'); localStorage.removeItem('user'); window.dispatchEvent(new Event('auth-expired'))
  }
  if (!response.ok) throw new Error(result.message || '保存失败，请重试')
  return result
}

export function createWeeklyReport(
  payload: WeeklyReportPayload,
  onContent: (content: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
  signal: AbortSignal
) {
  return streamPost(
    '/api/weekly-report',
    payload,
    { onContent, onDone, onError },
    signal
  )
}
