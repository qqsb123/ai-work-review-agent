const styleInstructions = {
  concise: `
输出风格：简洁型。
控制篇幅，突出本周最重要的工作成果、问题和下周计划。
避免空泛套话。
`,
  detailed: `
输出风格：详细型。
需要把工作内容整理成有层次的总结，可以适当说明完成情况、遇到的问题及改进方向。
`,
  okr: `
输出风格：OKR 型。
将本周工作尽量整理为 Objective / Key Results 的结构。
如果用户没有提供可以确定的量化指标，不要自行虚构数字。
`
}

export function buildWeeklyReportPrompt({ work, problems, nextPlan, style, historyContext = '' }) {
  const historySection = historyContext
    ? `\n以下是该用户最近的历史周报上下文，仅用于识别工作连续性、承接上周计划和避免重复表述。不得把历史内容误写成本周新完成事项：\n${historyContext}\n`
    : ''

  return `
你是一名专业的周报整理助手。

你的任务是：严格根据用户提供的真实信息，整理一份结构清晰、表达专业、可以直接用于提交的中文周报。

${styleInstructions[style] || styleInstructions.detailed}
${historySection}
用户本周工作/学习内容：
${work || '未填写'}

用户遇到的问题：
${problems || '未填写'}

用户下周计划：
${nextPlan || '未填写'}

严格要求：
1. 只能整理、归纳和润色用户提供的信息。
2. 不得虚构用户没有做过的项目、成果、数据或业务指标。
3. 如果提供了历史上下文，可以指出“延续上周计划”“持续推进”等连续性，但必须有上下文依据。
4. 历史周报中的旧成果不能当作本周新成果。
5. 如果信息不足，可以使用概括性表达，但不能编造事实。
6. 使用 Markdown 输出。
7. 包含“本周工作总结”“问题与改进”“下周计划”等清晰结构。
8. 语言自然，不要出现“作为 AI”“根据您的输入”等元话术。
`
}

export function buildRewritePrompt({ content, mode }) {
  const modeInstruction = {
    professional: '在不改变事实的前提下，把表达改得更专业、清晰、有职场感。',
    concise: '在不丢失关键信息的前提下明显压缩篇幅，删除重复和空泛表达。',
    okr: '在不虚构任何数字或成果的前提下，尽可能重构为 Objective / Key Results 风格。'
  }[mode]

  return `
你是一名严谨的中文周报编辑助手。

任务：${modeInstruction}

原始周报：
${content}

要求：
1. 不得新增原文没有的项目、成果、指标、时间、人员或业务事实。
2. 不得把推测写成事实。
3. 保留原始周报的核心事实和逻辑。
4. 使用 Markdown 输出。
5. 直接输出修改后的周报，不要解释修改过程。
`
}

export function buildInsightsPrompt(historyContext) {
  return `
你是一名工作复盘分析助手。请严格基于下面的历史周报进行趋势分析，不得编造。

历史周报：
${historyContext}

请输出 Markdown，并包含：
## 近期工作主线
概括最近几周持续推进的主要方向。

## 连续性与推进情况
识别“上周计划 → 后续完成”的承接关系；如果证据不足就明确说无法判断。

## 可能的反复问题
只指出历史周报中多次出现的问题或阻塞，不允许臆测。

## 下周建议
给出 3 条基于历史内容的可执行建议，不新增用户从未提到的业务事实。

要求：
1. 所有结论必须能从历史周报中找到依据。
2. 不要虚构数据、绩效评价或完成比例。
3. 不要输出“作为 AI”等元话术。
`
}
