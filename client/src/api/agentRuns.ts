import { streamPost, type AgentTraceEvent } from './sse'

export interface AgentRun {
  runId: string; task: string; status: string; attempt: number; createdAt: string; leaseUntil?: string;
  events?: AgentTraceEvent[]; result?: Record<string, unknown>; checkpoint?: Record<string, unknown>; errorCode?: string
}
export async function getAgentData<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, signal })
  const data = await response.json()
  if (response.status === 401) {
    localStorage.removeItem('token'); localStorage.removeItem('user'); window.dispatchEvent(new Event('auth-expired'))
  }
  if (!response.ok) throw new Error(data.message || '无法读取执行记录')
  return data as T
}
export function retryAgentRun(runId: string, onResult: (result: Record<string, unknown>) => void,
  onError: (message: string) => void, signal: AbortSignal) {
  return streamPost(`/api/ai/runs/${encodeURIComponent(runId)}/retry`, {}, {
    onContent: () => {}, onDone: () => {}, onResult, onError, requireResult: true
  }, signal)
}
