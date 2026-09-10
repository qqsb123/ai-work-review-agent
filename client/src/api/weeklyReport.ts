import { streamPost } from './sse'

export interface WeeklyReportPayload {
  work: string
  problems: string
  nextPlan: string
  style: 'concise' | 'detailed' | 'okr'
  useHistory: boolean
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
