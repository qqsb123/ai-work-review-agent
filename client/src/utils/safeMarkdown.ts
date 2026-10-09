import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function safeMarkdown(content: string) {
  return DOMPurify.sanitize(marked.parse(content || '') as string, { USE_PROFILES: { html: true } })
}
