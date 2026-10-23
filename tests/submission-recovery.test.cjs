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

test("repost-only selections need no AI key and stay eligible in the worker", async () => {
  const w = await worker();
  for (const taskType of ["转发", "转发互动", "转推", "转帖", "Repost", "Retweet", "点赞+转发"]) {
    assert.equal(w.c.missingAIKeyMessage({}, {taskType}), "");
    assert.equal(w.c.isIgnoredNonCommentTask({taskType}), false);
  }
  assert.equal(w.c.isIgnoredNonCommentTask({title: "转发互动任务"}), false);
  assert.notEqual(w.c.missingAIKeyMessage({}, {taskType: "评论+转发"}), "");
  assert.equal(w.c.isIgnoredNonCommentTask({taskType: "引用"}), true);
  assert.equal(w.c.isIgnoredNonCommentTask({taskType: "原创推文"}), true);
});

test("upgrading repost eligibility leaves V4 history intact and rechecks exclusions under the new policy", async () => {
  const w = await worker();
  const legacy = ["stable|转发|2.55|@yapmarkets|转发互动", task.tweetUrl, "text|old unsupported task"];
  w.stored.permanentIgnoredTaskKeysV4 = [...legacy];
  vm.runInContext("permanentIgnoredTaskKeysLoaded = false", w.c);
  assert.equal((await w.c.ensurePermanentIgnoredTaskKeysLoaded()).size, 0);
  assert.deepEqual(w.stored.permanentIgnoredTaskKeysV4, legacy);
  await w.c.markPermanentIgnoredTask({taskKey: "original-order", taskType: "原创推文"});
  vm.runInContext("permanentIgnoredTaskKeysLoaded = false", w.c);
  assert.equal((await w.c.ensurePermanentIgnoredTaskKeysLoaded()).has("original-order"), true);
  assert.deepEqual(w.stored.permanentIgnoredTaskKeysV4, legacy);
});

test("confirmed repost uses the existing same-order submission recovery and resumes scanning", async () => {
  const w = await worker();
  w.state().currentTask.taskType = "转发";
  await w.c.handleXReplyResult({ok: true, mode: "repost", repost: {ok: true, status: "reposted"}}, {runId: "run"});
  assert.equal(w.state().completed, 1);
  assert.equal(w.sent.filter(type => type === "COMPLETE_X_TASK_WIDGET").length, 1);
  assert.equal(w.sent.includes("RUN_X_REPLY"), false);
  assert.ok(w.effects.includes("scan"));
});

test("unconfirmed repost keeps its locked order without submitting or opening the next task", async () => {
  const w = await worker("pending");
  w.state().currentTask.taskType = "转发";
  await w.c.handleXReplyResult({ok: false, mode: "repost", message: "转发结果未确认"}, {runId: "run"});
  assert.equal(w.state().completed, 0);
  assert.equal(w.state().running, false);
  assert.equal(w.state().currentTask.taskKey, task.taskKey);
  assert.equal(w.sent.includes("COMPLETE_X_TASK_WIDGET"), false);
  assert.equal(w.sent.includes("RUN_X_REPLY"), false);
  assert.deepEqual(w.effects, []);
});
