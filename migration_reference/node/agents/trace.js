// Strict public projection: never serialize arbitrary provider messages/errors.
export function argumentSummary(call) {
  try {
    const args = JSON.parse(call.function?.arguments || '{}')
    return Object.fromEntries(Object.entries(args).filter(([key]) => ['query','keyword','limit','offset','reportId','planId'].includes(key)).map(([key, value]) => [key,
      typeof value === 'string' ? { type: 'text', chars: value.length } : typeof value === 'number' ? value : { type: typeof value }]))
  } catch { return { invalidJson: true } }
}
export function resultSummary(result) {
  return {
    ...(Array.isArray(result?.reports) ? { reportIds: result.reports.map(r => r.id).slice(0, 10), count: result.reports.length } : {}),
    ...(result?.id ? { reportId: result.id, chars: result.content?.length || 0 } : {}),
    ...(Array.isArray(result?.plans) ? { count: result.plans.length } : {}),
    ...(result?.error ? { errorCode: 'TOOL_INPUT_INVALID' } : {}),
    ...(result?.retrieval ? { retrieval: result.retrieval } : {})
  }
}
