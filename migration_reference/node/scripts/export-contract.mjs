import { writeFile } from 'node:fs/promises'
import { createPrepareHandler,createWeeklyHandler,createConfirmHandler } from '../services/weeklyHandlers.js'
import { createInsightsHandler } from '../agents/insightsHandler.js'
import { createDraftStore } from '../services/draftStore.js'
import { createMemoryDb,TestResponse,finalResponse,toolResponse,toolCall,quietLogger } from '../tests/helpers.js'

const rows=[{id:1,user_id:7,work_content:'登录模块开发完成并通过自测。',next_plan:'完成权限模块',content:'登录模块开发完成并通过自测。',created_at:'2026-09-01',updated_at:'2026-09-01'},
 {id:2,user_id:7,work_content:'权限模块正在进行联调。',next_plan:'',content:'权限模块正在进行联调。',created_at:'2026-09-08',updated_at:'2026-09-08'}]
const db=createMemoryDb(rows),store=createDraftStore(),input={work:rows[0].content,problems:'',nextPlan:'',style:'detailed',useHistory:false}
const req=body=>({user:{userId:7},body})
const prepared=new TestResponse()
await createPrepareHandler({db,store,logger:quietLogger,complete:async()=>finalResponse({questions:[]})})(req(input),prepared)
const preparedResult=prepared.events().find(e=>e.type==='result').result
const generated=new TestResponse()
await createWeeklyHandler({db,store,logger:quietLogger,stream:async({res,onComplete})=>{res.write(`data: ${JSON.stringify({type:'content',content:rows[0].content})}\n\n`);await onComplete(rows[0].content);res.write('data: [DONE]\n\n');res.end()}})(req({sessionId:preparedResult.sessionId,answers:[],skipClarification:true}),generated)
const generatedResult=generated.events().find(e=>e.type==='result').result
const confirmed=new TestResponse()
await createConfirmHandler({db,store,logger:quietLogger})(req({sessionId:preparedResult.sessionId,content:generatedResult.content,confirm:true}),confirmed)
const responses=[toolResponse(toolCall('read_report',{reportId:1},'r1'),toolCall('read_report',{reportId:2},'r2')),
 finalResponse({workstreams:[{text:'登录完成自测，权限进入联调。',evidence:rows.map(r=>({reportId:r.id,quote:r.content}))}],continuity:[],recurringProblems:[],suggestions:[]})]
const insight=new TestResponse()
await createInsightsHandler({db,logger:quietLogger,complete:async()=>responses.shift()})(req({question:''}),insight)
const insightsResult=insight.events().find(e=>e.type==='result').result
const baseline={source:'Frozen Node reference before FastAPI cutover',prepareKeys:Object.keys(preparedResult).sort(),generateKeys:Object.keys(generatedResult).sort(),confirmKeys:Object.keys(confirmed.body).sort(),
 insightKeys:Object.keys(insightsResult).sort(),sections:insightsResult.sections.map(s=>({key:s.key,title:s.title})),sourceKeys:Object.keys(insightsResult.sources[0]).sort(),
 protocol:['content','progress','trace','result','[DONE]'],generatedContent:generatedResult.content,successfulDone:[prepared,generated,insight].every(r=>r.output.endsWith('data: [DONE]\n\n'))}
await writeFile(new URL('../../../backend/tests/node_contract.json',import.meta.url),JSON.stringify(baseline,null,2)+'\n')
console.log('Frozen Node contract baseline exported; synthetic data only.')
