"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const task={taskKey:"submitted-order",tweetUrl:"https://x.com/fixture/status/123",seatLocked:true};
const event={addListener(){}};
async function worker(outcome="completed") {
  let now=1000000;class Clock extends Date {static now(){return now;}}
  const stored={},sent=[],effects=[];
  const chrome={runtime:{id:"test",getURL:p=>`chrome-extension://test/${p}`,getManifest:()=>({version:"test"}),onInstalled:event,onMessage:event},
    storage:{session:require("./session-fixture.cjs")(),local:{async setAccessLevel(){},async get(keys){return Object.fromEntries(keys.map(k=>[k,stored[k]]));},
      async set(value,callback){Object.assign(stored,JSON.parse(JSON.stringify(value)));callback?.();}}},
    alarms:{onAlarm:event,async create(){},async clear(){}},
    tabs:{onCreated:event,onUpdated:event,onRemoved:event,async sendMessage(id,m){
      sent.push(m.type);
      if(m.type==="RUN_X_REPLY"||m.type==="COMPLETE_X_TASK_WIDGET") throw Error("The message port closed before a response was received.");
      if(m.type==="CHECK_X_TASK_WIDGET_COMPLETION") return outcome==="completed" ? {ok:true,completed:true,evidence:{source:"lighthouse_x_widget",runId:m.runId,taskKey:task.taskKey,tweetUrl:task.tweetUrl}} : {ok:true,completed:false};
      if(m.type==="CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION")return {ok:true,completed:false};
      if(m.type==="BEGIN_LIGHTHOUSE_COMPLETION_WATCH")return {ok:true};
      if(m.type==="CHECK_LIGHTHOUSE_EXECUTION_STATE")return {ok:true,present:false};
      throw Error("Unexpected action "+m.type);
    }}};
  const c=vm.createContext({chrome,Date:Clock,URL,AbortController,console,importScripts(){},setTimeout,clearTimeout,
    fetch:async()=>{throw Error("Network forbidden");}});
  for(const file of ["reply-engine.js","background.js"])vm.runInContext(fs.readFileSync(path.join(__dirname,"../src",file),"utf8"),c);
  await vm.runInContext("runtimeStateReady",c);
  Object.assign(c,{ensureLighthouseAlertBridge:async()=>{},publishLighthouseMonitorSnapshot(){},
    recordReplyHistory:async()=>{}, waitForOfficialLighthouseCompletionDuringXSubmission:async()=>null,
    getOrCreateLighthouseTab:async()=>({id:11,windowId:1}),rememberLighthouseTabById:async()=>{},
    closeLighthouseDetailToCampaigns:async()=>{effects.push("close");return true;},
    reloadLighthouseCampaignsAfterOrder:async()=>{effects.push("reload");return true;},
    startNextAutoTask:async()=>{effects.push("scan");return {ok:true};},delay:async ms=>{now+=ms;}});
  const state=()=>vm.runInContext("runtimeState",c);
  Object.assign(state(),{running:true,mode:"auto",runId:"run",lighthouseTabId:11,xTabId:12,currentTask:{...task}});
  return {c,chrome,state,sent,effects,stored};
}
test("lost submission receipt can finish from the current completed badge without resubmitting",async()=>{
  const w=await worker();
  await w.c.handleXReplyResult({ok:true,mode:"post"},{runId:"run"});
  assert.equal(w.state().completed,1);assert.equal(w.state().running,true);
  assert.equal(w.sent.filter(t=>t==="COMPLETE_X_TASK_WIDGET").length,1);
  assert.ok(w.sent.includes("CHECK_X_TASK_WIDGET_COMPLETION"));
  assert.equal(w.sent.includes("RUN_X_REPLY"),false);
  assert.equal(w.state().uncertainAction,null);
  assert.ok(w.effects.includes("scan"));
});
test("an inconclusive submission loss remains protected after read-only verification times out",async()=>{
  const w=await worker("pending");
  await w.c.handleXReplyResult({ok:true,mode:"post"},{runId:"run"});
  assert.equal(w.state().running,false);assert.equal(w.state().completed,0);
  assert.equal(w.state().uncertainAction.type,"COMPLETE_X_TASK_WIDGET");
  assert.equal(w.state().currentTask.taskKey,task.taskKey);
  assert.equal(w.sent.filter(t=>t==="COMPLETE_X_TASK_WIDGET").length,1);
  assert.ok(w.sent.includes("CHECK_X_TASK_WIDGET_COMPLETION"));assert.deepEqual(w.effects,[]);
});
test("a lost X publish receipt still stops and is never replayed",async()=>{
  const w=await worker();await w.c.sendToTab(12,{type:"RUN_X_REPLY",runId:"run",task});
  assert.equal(w.state().running,false);assert.deepEqual(w.sent,["RUN_X_REPLY"]);
  assert.equal(w.state().uncertainAction.type,"RUN_X_REPLY");
});

for (const mode of ["debug"]) test(`submission-loss recovery does not revive a ${mode} run`,async()=>{
  const w=await worker();Object.assign(w.state(),{mode,lastXResult:{ok:true}});
  await w.c.sendToTab(12,{type:"COMPLETE_X_TASK_WIDGET",runId:"run",task});
  assert.equal(w.state().running,false);assert.deepEqual(w.sent,["COMPLETE_X_TASK_WIDGET"]);
});
for (const transition of ["stop","new_run","storage_failure"]) test(`submission respects ${transition} before dispatching the pending action`,async()=>{
  const w=await worker();w.state().lastXResult={ok:true};
  const original=w.chrome.storage.local.set;
  w.chrome.storage.local.set=async(values,callback)=>{
    if(!callback&&values.lighthouseAutoRunStateV1?.uncertainAction?.type==="COMPLETE_X_TASK_WIDGET") {
      if(transition==="storage_failure")throw Error("storage unavailable");
      if(transition==="stop")Object.assign(w.state(),{running:false,manuallyStopped:true,stage:"stopped"});
      else Object.assign(w.state(),{runId:"new-run",stage:"new_run"});
    }
    return original(values,callback);
  };
  const result=await w.c.sendToTab(12,{type:"COMPLETE_X_TASK_WIDGET",runId:"run",task});
  assert.notEqual(result.ok,true);assert.deepEqual(w.sent,[]);
  if(transition==="new_run")assert.equal(w.state().stage,"new_run");
  else assert.equal(w.state().running,false);
});
test("lost submission without a confirmed reply cannot enter auto verification",async()=>{
  const w=await worker();await w.c.sendToTab(12,{type:"COMPLETE_X_TASK_WIDGET",runId:"run",task});
  assert.equal(w.state().running,false);assert.deepEqual(w.sent,["COMPLETE_X_TASK_WIDGET"]);
});

test("selected run shares the read-only submission recovery used by full scanning",async()=>{
  const w=await worker();w.state().mode="selected_once";
  await w.c.handleXReplyResult({ok:true,mode:"post"},{runId:"run"});
  assert.equal(w.state().completed,1);assert.equal(w.state().running,false);
  assert.equal(w.state().stage,"selected_flow_done");
  assert.equal(w.sent.filter(t=>t==="COMPLETE_X_TASK_WIDGET").length,1);
  assert.equal(w.state().uncertainAction,null);
  assert.equal(w.effects.includes("scan"),false);
});
