import { streamPost } from './sse'

export type RewriteMode = 'professional' | 'concise' | 'okr'

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
  onContent: (content: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
  signal: AbortSignal
) {
  return streamPost(
    '/api/ai/insights',
    {},
    { onContent, onDone, onError },
    signal
  )
}
