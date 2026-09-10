export interface Report {
  id: number
  work_content: string
  problems: string
  next_plan: string
  style: 'concise' | 'detailed' | 'okr'
  content: string
  created_at: string
  updated_at: string
}

function authHeaders(includeJson = false) {
  const token = localStorage.getItem('token')
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token || ''}`
  }
}

async function parseResponse(response: Response) {
  const result = await response.json().catch(() => ({}))

  if (response.status === 401) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.dispatchEvent(new Event('auth-expired'))
    throw new Error(result.message || '登录已过期，请重新登录')
  }

  if (!response.ok) {
    throw new Error(result.message || '请求失败')
  }

  return result
}

export async function getReports(): Promise<Report[]> {
  const response = await fetch('/api/reports', {
    headers: authHeaders()
  })
  const result = await parseResponse(response)
  return result.data
}

export async function updateReport(id: number, content: string) {
  const response = await fetch(`/api/reports/${id}`, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify({ content })
  })
  return parseResponse(response)
}

export async function deleteReport(id: number) {
  const response = await fetch(`/api/reports/${id}`, {
    method: 'DELETE',
    headers: authHeaders()
  })
  return parseResponse(response)
}
