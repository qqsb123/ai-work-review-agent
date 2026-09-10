import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWeeklyReportPrompt,
  buildRewritePrompt,
  buildInsightsPrompt
} from '../prompts/weeklyReport.js'

test('weekly report prompt keeps factuality constraints and history boundary', () => {
  const prompt = buildWeeklyReportPrompt({
    work: '完成登录模块',
    problems: 'Token 过期处理不熟悉',
    nextPlan: '完善权限模块',
    style: 'detailed',
    historyContext: '上周计划：完成登录模块'
  })

  assert.match(prompt, /完成登录模块/)
  assert.match(prompt, /不得虚构/)
  assert.match(prompt, /历史周报中的旧成果不能当作本周新成果/)
})

test('rewrite prompt preserves source content and selected mode', () => {
  const prompt = buildRewritePrompt({
    content: '本周完成登录功能',
    mode: 'concise'
  })

  assert.match(prompt, /本周完成登录功能/)
  assert.match(prompt, /压缩篇幅/)
  assert.match(prompt, /不得新增原文没有的/)
})

test('insights prompt requires evidence-grounded conclusions', () => {
  const prompt = buildInsightsPrompt('第一周：完成登录\n第二周：完善权限')
  assert.match(prompt, /所有结论必须能从历史周报中找到依据/)
  assert.match(prompt, /承接关系/)
})
