import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pool from '../db/index.js'
import { createAgentRunStore } from '../services/agentRunStore.js'
import { createPersistentDraftStore } from '../services/persistentDraftStore.js'
import { createHybridRetrieval } from '../services/hybridRetrieval.js'
import { createReportTools } from '../agents/reportTools.js'
import { createConfirmationTool } from '../tools/confirmReport.js'
import { createPrepareHandler } from '../services/weeklyHandlers.js'
import { createInsightsHandler } from '../agents/insightsHandler.js'
import { createDeepSeekCompletion } from '../services/deepseek.js'
import { createEmbeddingProvider } from '../services/embeddings.js'
import { TestResponse, toolCall, finalResponse, quietLogger } from '../tests/helpers.js'
import express from 'express'
import jwt from 'jsonwebtoken'
import { fileURLToPath } from 'node:url'
import { createAgentRunsRouter } from '../routes/agentRuns.js'
import authMiddleware from '../middleware/auth.js'
import { createWeeklyHandler, createConfirmHandler } from '../services/weeklyHandlers.js'
import { toolResponse } from '../tests/helpers.js'

let connection
let httpServer
const live = process.argv.includes('--live')
const liveEmbedding = process.argv.includes('--embedding')
try {
  connection = await pool.getConnection()
  const db = { execute: (sql,args) => connection.execute(sql,args) }
  // Connection-local tables shadow production names. No real business/run data
  // is written, even if verification fails. Closing the connection removes them.
  const ddl = (await readFile(new URL('../sql/agent-engineering.sql',import.meta.url),'utf8'))
    .replace(/^--.*$/gm,'').replace(/CREATE TABLE IF NOT EXISTS/g,'CREATE TEMPORARY TABLE')
    .replace(/,\s*CONSTRAINT fk_trace_run[^\n]*/g,'')
  for (const sql of ddl.split(';').map(s=>s.trim()).filter(Boolean)) await db.execute(sql)
  await db.execute(`CREATE TEMPORARY TABLE reports (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,user_id BIGINT UNSIGNED NOT NULL,
    work_content TEXT,problems TEXT,next_plan TEXT,style VARCHAR(16),content MEDIUMTEXT,
    request_key VARCHAR(36),created_at DATETIME,updated_at DATETIME,
    UNIQUE KEY owner_request (user_id,request_key))`)
  await db.execute(`INSERT INTO reports (id,user_id,work_content,next_plan,style,content,created_at,updated_at) VALUES
    (1,7,'登录模块开发完成并通过自测。','完成权限模块','detailed','登录模块开发完成并通过自测。','2026-09-01','2026-09-01'),
    (2,7,'权限模块正在进行联调。','','detailed','权限模块正在进行联调。','2026-09-08','2026-09-08'),
    (3,8,'秘密登录模块已上线。','','detailed','秘密登录模块已上线。','2026-09-10','2026-09-10')`)
  const store = createAgentRunStore(db), drafts = createPersistentDraftStore(db)
  const requestKey = randomUUID(), input = { question:'身份验证和访问控制模块的进展' }
  const run = await store.begin({ userId:7,task:'insights',input,requestKey })
  await assert.rejects(store.begin({userId:7,task:'insights',input,requestKey}),{code:'RUN_CONFLICT'})
  await assert.rejects(store.begin({userId:7,task:'insights',input:{question:'changed'},requestKey}),{code:'RUN_CONFLICT'})
  await store.record(run,{type:'trace',stage:'model_start',meta:{step:1}},{boundary:'model_start',recovery:'restart_from_input'})
  await store.finish(run,'aborted',null,'CLIENT_ABORTED')
  const restartedStore = createAgentRunStore(db)
  await assert.rejects(restartedStore.get(run.runId,8),{code:'RUN_NOT_FOUND'})
  assert.equal((await restartedStore.get(run.runId,7)).checkpoint.recovery,'restart_from_input')
  const retry = await restartedStore.begin({userId:7,task:'insights',input,requestKey,retry:true})
  assert.equal(retry.runId,run.runId); assert.equal(retry.attempt,2)
  await assert.rejects(store.finish(run,'succeeded',{}),{code:'RUN_LEASE_LOST'})
  await store.finish(retry,'succeeded',{checked:true})
  assert.deepEqual((await store.begin({userId:7,task:'insights',input,requestKey})).replay,{checked:true})
  const crashed = await store.begin({userId:7,task:'insights',input,requestKey:randomUUID()})
  await db.execute('UPDATE agent_runs SET lease_until=? WHERE run_id=?',[new Date('2000-01-01'),crashed.runId])
  const reclaimed = await store.begin({userId:7,task:'insights',input,requestKey:crashed.requestKey,retry:true})
  await assert.rejects(store.finish(crashed,'succeeded',{}),{code:'RUN_LEASE_LOST'})
  await store.finish(reclaimed,'failed',null,'PROVIDER_FAILED')
  const third = await store.begin({userId:7,task:'insights',input,requestKey:crashed.requestKey,retry:true})
  await store.finish(third,'failed',null,'PROVIDER_FAILED')
  await assert.rejects(store.begin({userId:7,task:'insights',input,requestKey:crashed.requestKey,retry:true}),{code:'RUN_CONFLICT'})

  const draftInput = {work:'登录模块已完成开发和自测。',problems:'',nextPlan:'权限联调',style:'detailed',useHistory:false}
  const draft = await drafts.create(7,draftInput)
  const freshDrafts = createPersistentDraftStore(db)
  await assert.rejects(freshDrafts.get(draft.id,8),{code:'DRAFT_NOT_FOUND'})
  assert.equal((await freshDrafts.get(draft.id,7)).input.work,draftInput.work)
  draft.state='generating'; draft.generationStartedAt=Date.now(); draft.generationToken=randomUUID()
  await drafts.claim(draft)
  await assert.rejects(drafts.claim({...draft,generationToken:randomUUID()}),{code:'DRAFT_STATE'})
  draft.state='ready'; draft.content=draftInput.work; await drafts.save(draft)
  const confirm = createConfirmationTool(db,freshDrafts)
  const ctx = {userId:7,signal:new AbortController().signal,confirmed:true,sources:new Map()}
  const saved = await confirm.execute(toolCall('confirm_report',{sessionId:draft.id,content:draft.content}),ctx)
  const duplicate = await confirm.execute(toolCall('confirm_report',{sessionId:draft.id,content:draft.content}),ctx)
  assert.equal(saved.reportId,duplicate.reportId)
  const [counts] = await db.execute('SELECT COUNT(*) AS count FROM reports WHERE request_key=?',[draft.id])
  assert.equal(Number(counts[0].count),1)
  // Hide temporary confirmation record from the synthetic retrieval fixture.
  await db.execute('DELETE FROM reports WHERE request_key=?',[draft.id])

  const provider = liveEmbedding ? createEmbeddingProvider() : {enabled:true,modelKey:'fixture-model',async embed(texts) {
    return {tokens:12,vectors:texts.map(t=>t.includes('权限')?[0,1]:[1,0])}
  }}
  if (liveEmbedding && !provider.enabled) throw new Error('EMBEDDING_NOT_CONFIGURED')
  const retrieval = createHybridRetrieval(db,provider), tools = createReportTools(db,[],retrieval)
  const retrieved = await tools.execute(toolCall('hybrid_search_reports',{query:'身份验证和访问控制'}),ctx)
  assert.equal(retrieved.retrieval.mode,'hybrid')
  assert.ok(retrieved.reports.some(r=>r.channels.includes('semantic')))
  assert.equal(retrieved.reports.some(r=>r.id===3),false)
  assert.equal(ctx.sources.size,0)
  await tools.execute(toolCall('read_report',{reportId:1}),ctx)
  await assert.rejects(tools.execute(toolCall('read_report',{reportId:3}),ctx),{code:'TOOL_INPUT_INVALID'})

  // Real persistence + HTTP lifecycle, including duplicate successful prepare.
  let completionCalls = 0
  const prepare = createPrepareHandler({db,store:drafts,runStore:store,logger:quietLogger,complete:async()=>{completionCalls++;return finalResponse({questions:[]})}})
  const prepareKey=randomUUID(), req={user:{userId:7},body:{...draftInput,requestKey:prepareKey}}
  const prepared=new TestResponse(); await prepare(req,prepared)
  const replayed=new TestResponse(); await prepare(req,replayed)
  assert.equal(completionCalls,1)
  assert.equal(prepared.events().find(e=>e.type==='result').result.sessionId,replayed.events().find(e=>e.type==='result').result.sessionId)
  const app=express();app.use(express.json())
  app.use('/api/ai',createAgentRunsRouter({runStore:store,retryHandlers:{clarification:prepare}}))
  const tokenFor=userId=>jwt.sign({userId},process.env.JWT_SECRET,{expiresIn:'1h'})
  httpServer=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))})
  const origin=`http://127.0.0.1:${httpServer.address().port}`
  const preparedId=prepared.events().find(e=>e.type==='result').result.runId
  assert.equal((await fetch(`${origin}/api/ai/runs`)).status,401)
  assert.equal((await fetch(`${origin}/api/ai/runs/${preparedId}`,{headers:{Authorization:`Bearer ${tokenFor(8)}`}})).status,404)
  const owned=await fetch(`${origin}/api/ai/runs/${preparedId}`,{headers:{Authorization:`Bearer ${tokenFor(7)}`}})
  assert.equal(owned.status,200);assert.equal((await owned.json()).status,'succeeded')
  const replayHTTP=await fetch(`${origin}/api/ai/runs/${preparedId}/retry`,{method:'POST',headers:{Authorization:`Bearer ${tokenFor(7)}`}})
  assert.ok((await replayHTTP.text()).endsWith('data: [DONE]\n\n'));assert.equal(completionCalls,1)
  await new Promise(resolve=>httpServer.close(resolve));httpServer=null
  let modelSummary = null
  if (live) {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('MODEL_NOT_CONFIGURED')
    const liveComplete = async args => {
      try { return await createDeepSeekCompletion(args) }
      catch(error) { console.info(JSON.stringify({providerFailure:{code:error.code || 'PROVIDER_FAILED',status:error.response?.status || null}})); throw error }
    }
    const handler=createInsightsHandler({db,complete:liveComplete,runStore:store,retrieval,logger:quietLogger})
    const response=new TestResponse()
    await handler({user:{userId:7},body:{question:'请用 hybrid_search_reports 召回身份验证和访问控制相关候选，再读取两份真实原文，复盘推进情况。',requestKey:randomUUID()}},response)
    if (!response.output.endsWith('data: [DONE]\n\n')) console.info(JSON.stringify({runFailure:response.events().find(e=>e.type==='error') || response.body}))
    assert.ok(response.output.endsWith('data: [DONE]\n\n'),'真实模型结果未完整结束')
    const result=response.events().find(e=>e.type==='result').result
    const trace=await store.get(result.runId,7)
    assert.ok(trace.events.some(e=>e.stage==='tool_end' && e.meta?.tool==='hybrid_search_reports'))
    assert.ok(trace.events.some(e=>e.stage==='tool_end' && e.meta?.tool==='read_report'))
    assert.ok(trace.events.some(e=>e.stage==='validation_passed'))
    assert.equal(JSON.stringify(trace.events).includes('reasoning_content'),false)
    modelSummary={verified:true,metrics:result.metrics,traceEvents:trace.events.length}
  }
  console.log(JSON.stringify({verified:true,realMySQL:true,httpAuthAndReplay:true,runReplay:true,leaseRecovery:true,attemptLimit:true,
    persistentDraft:true,humanConfirmation:true,ownerIsolation:true,embedding:liveEmbedding?'real-provider':'fixture-only',
    realModel:modelSummary,realUserDataWritten:false},null,2))
  if(process.argv.includes('--preview')) {
    // Only temporary tables are reachable in this local QA preview.
    app.post('/api/auth/login',(req,res)=>req.body?.username==='engineering-demo' && req.body?.password==='demo-password'
      ?res.json({data:{token:tokenFor(7),user:{username:'合成验收账号'}}}):res.status(401).json({message:'仅接受合成验收账号'}))
    app.get('/api/reports',authMiddleware,async(req,res)=>{
      const [rows]=await db.execute('SELECT * FROM reports WHERE user_id=?',[req.user.userId]);res.json({code:0,data:rows})
    })
    const fixtureComplete=async({messages})=>{
      const results=messages.filter(m=>m.role==='tool')
      if(!results.length)return toolResponse(toolCall('hybrid_search_reports',{query:'身份验证与访问控制'},randomUUID()))
      if(results.length===1)return toolResponse(toolCall('read_report',{reportId:1},randomUUID()),toolCall('read_report',{reportId:2},randomUUID()))
      return finalResponse({workstreams:[{text:'登录模块已完成自测，权限模块进入联调。',evidence:[{reportId:1,quote:'登录模块开发完成并通过自测。'},{reportId:2,quote:'权限模块正在进行联调。'}]}],continuity:[],recurringProblems:[],suggestions:[]})
    }
    app.post('/api/ai/insights',authMiddleware,createInsightsHandler({db,complete:fixtureComplete,runStore:store,retrieval,logger:quietLogger}))
    app.post('/api/weekly-report/prepare',authMiddleware,prepare)
    app.get('/api/weekly-report/drafts/:id',authMiddleware,async(req,res)=>{
      try {const draft=await drafts.get(req.params.id,req.user.userId);res.json({sessionId:draft.id,input:draft.input,questions:draft.questions,state:draft.state,content:draft.content,expiresAt:draft.expiresAt})}
      catch {res.status(404).json({message:'草稿不存在'})}
    })
    const fixtureStream=async({res,onComplete})=>{res.write(`data: ${JSON.stringify({type:'content',content:draftInput.work})}\n\n`);await onComplete(draftInput.work);res.write('data: [DONE]\n\n');res.end()}
    app.post('/api/weekly-report',authMiddleware,createWeeklyHandler({db,stream:fixtureStream,store:drafts,logger:quietLogger}))
    app.post('/api/weekly-report/confirm',authMiddleware,createConfirmHandler({db,store:drafts,logger:quietLogger}))
    app.use(express.static(fileURLToPath(new URL('../../client/dist',import.meta.url))))
    await new Promise(resolve=>{httpServer=app.listen(4174,'127.0.0.1',()=>{console.log('QA preview http://127.0.0.1:4174 — engineering-demo / demo-password (temporary synthetic data only)')});httpServer.once('close',resolve)})
  }
} catch (error) { console.error(JSON.stringify({verified:false,code:error.code||error.message||'VERIFICATION_FAILED'}));process.exitCode=1 }
finally { if(httpServer)await new Promise(resolve=>httpServer.close(resolve));connection?.destroy();await pool.end() }
