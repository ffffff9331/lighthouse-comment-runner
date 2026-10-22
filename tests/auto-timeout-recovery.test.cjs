"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const KEY = "lighthouseAutoRunStateV1";
const ALARM = "lighthouseAutoRecoveryV1";
const LIMIT = 20 * 60 * 1000;
const target = "https://x.com/fixture/status/123";
const task = { taskKey: "order-123", tweetUrl: target, title: "Fixture order" };

function content(options = {}) {
  let listener;
  const fixture = { counters: (options.labels || ["进行中\n0"]).map(innerText => ({innerText, visible: options.visible !== false})),
    outcome: options.outcome || {outcome: "unknown", ...task}, execution: {present: Boolean(options.execution)},
    invitation: options.invitation || "absent", loading: options.loading === true,
    detail: options.detailText ? {innerText:options.detailText,querySelectorAll:()=>[]} : null };
  const c = vm.createContext({console, URL, fixture, setTimeout, clearTimeout,
    location: {href: "https://app.lhdao.top/campaigns", pathname: options.pathname || "/campaigns"},
    window: {addEventListener() {}}, document: {body: {}, querySelectorAll(selector) {
      assert.equal(selector, "button[data-tab='ongoing']"); return fixture.counters;
    }}, chrome: {runtime: {onMessage: {addListener(fn) {listener = fn;}}, async sendMessage() {return {ok:true,paused:false};}}}});
  const raw = source("content/lighthouse.js"), end = raw.lastIndexOf("})();");
  vm.runInContext(raw.slice(0,end) + `
    isVisible = node => node.visible;
    readBoundOrderOutcome = () => fixture.outcome;
    findExecutionDialog = () => fixture.execution;
    findTaskDetailRoot = () => fixture.detail;
    getStandaloneInvitationState = () => fixture.invitation;
    hasLoadedCampaignListShell = () => !fixture.loading;
  ` + raw.slice(end), c);
  return () => { let result; listener({type:"CHECK_LIGHTHOUSE_RECOVERY_STATE",platform:"lighthouse",runId:"new-run",recoveryId:"recovery",task}, {}, value => {result=value;}); return result; };
}

test("recovery reads the official zero counter without clicking or reviving content", () => {
  const result=content()();
  assert.equal(result.ok,true); assert.equal(result.activeCount,0);
  assert.equal(result.recoveryId,"recovery"); assert.equal(result.runId,"new-run");
  assert.equal(result.executionPresent,false); assert.equal(result.invitationPending,false);
});
for (const options of [{labels:[]},{labels:["进行中 0","进行中 0"]},{labels:["进行中 加载中"]},{visible:false}]) {
  test(`unreadable order count is not zero: ${JSON.stringify(options)}`, () => assert.equal(content(options)().activeCount,null));
}
test("active orders and invitations remain explicit recovery blockers", () => {
  const result=content({labels:["进行中 1"],execution:true,invitation:"pending"})();
  assert.equal(result.activeCount,1); assert.equal(result.executionPresent,true); assert.equal(result.invitationPending,true);
});
test("a count on a different route cannot authorize recovery", () => assert.equal(content({pathname:"/wallet"})().ok,false));
test("a loading page cannot authorize clearing an order with a provisional zero counter", () => assert.equal(content({loading:true})().activeCount,null));
test("a locked detail protects its order even when the official count still reads zero",()=>{
  const result=content({detailText:"任务详情 席位已锁定 去 X 完成动作"})();
  assert.equal(result.activeCount,0);assert.equal(result.executionPresent,true);
});

async function worker(options = {}) {
  let now=1000000, alarmListener;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}}
  const stored=options.saved?{[KEY]:clone(options.saved)}:{}, sent=[], reloads=[], scans=[], done=[], alarms=new Map(), hooks={};
  let pageInstance="before-reload";
  const event={addListener(){}};
  const chrome={runtime:{id:"test",getURL:p=>`chrome-extension://test/${p}`,getManifest:()=>({version:"test"}),getPlatformInfo:async()=>({}),onInstalled:event,onMessage:event},
    storage:{local:{setAccessLevel:async()=>{},async get(keys){return Object.fromEntries(keys.filter(k=>Object.hasOwn(stored,k)).map(k=>[k,stored[k]]));},async set(values,cb){await hooks.persist?.(values,cb);Object.assign(stored,clone(values));cb?.();}}},
    alarms:{onAlarm:{addListener(fn){alarmListener=fn;}},async create(name,config){alarms.set(name,config);},async clear(name){alarms.delete(name);}},
    tabs:{onCreated:event,onUpdated:event,onRemoved:event,async get(id){await hooks.get?.(id);return {id,windowId:1,url:id===22?target:"https://app.lhdao.top/campaigns",...options.tabs?.[id]};},
      async reload(id){reloads.push(id);await hooks.reload?.(id);pageInstance="after-reload";},
      async sendMessage(id,message){sent.push(clone(message));await hooks.message?.(message);
        if(message.type.startsWith("CANCEL_"))return {ok:options.cancelOk!==false};
        if(message.type==="CHECK_LIGHTHOUSE_RECOVERY_STATE")return {ok:true,runId:message.runId,recoveryId:message.recoveryId,instanceId:pageInstance,...task,
          outcome:options.outcome||"unknown",activeCount:options.activeCount??0,executionPresent:false,invitationPending:false,...options.snapshot};
        throw Error("Unexpected message "+message.type);
      }}};
  const c=vm.createContext({chrome,console,URL,Date:Clock,AbortController,importScripts(){},clearTimeout,
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},fetch:async()=>{throw Error("Network forbidden");}});
  for(const file of ["reply-engine.js","background.js"])vm.runInContext(source(file),c,{filename:file});
  await vm.runInContext("runtimeStateReady",c);
  Object.assign(c,{publishLighthouseMonitorSnapshot(){},ensureContentScriptInjected:async()=>options.injectOk!==false,waitForTabComplete:async()=>options.loadOk!==false,
    delay:async ms=>{now+=ms;},
    getSettings:async()=>({aiApiKey:"fixture",replyMode:"post",autoSubmitLighthouse:true,maxTasksPerRun:9999,maxTaskAttempts:9999,runWindowEnabled:false}),
    startNextAutoTask:async reason=>{scans.push(reason);return {ok:true};},
    handleLighthouseDone:async()=>{done.push(true);return {ok:true};},
    resumeReconciledClaim:async()=>{scans.push("resume-original");return {ok:true};}});
  if(!options.saved)vm.runInContext(`Object.assign(runtimeState,{running:false,mode:"auto",stage:"action_result_unknown",runId:"old-run",lighthouseTabId:11,runtimeWindowId:1,lighthouseWindowId:1,lastProgressAt:1000000,currentTask:${JSON.stringify(task)},uncertainAction:{type:"START_LIGHTHOUSE_COMMENT_TASK",runId:"old-run",tabId:11,intentId:"intent"},autoRecovery:{deadlineAt:1000000+${LIMIT},mode:"auto"}})`,c);
  const state=()=>vm.runInContext("runtimeState",c);
  return {c,stored,sent,reloads,scans,done,alarms,hooks,state,advance:ms=>{now+=ms;},
    tick:()=>c.handleAutoRunKeepaliveTick(),
    stop:()=>vm.runInContext('runtimeState={...createInitialState(),manuallyStopped:true,stage:"stopped"}',c),
    alarm:()=>alarmListener({name:ALARM})};
}

test("an uncertain automatic run restarts at twenty minutes without waiting for an order receipt",async()=>{
  const w=await worker();w.advance(LIMIT-1);await w.tick();assert.equal(w.reloads.length,0);
  w.advance(1);await w.tick();
  assert.deepEqual(w.reloads,[11]);assert.equal(w.scans.length,1);assert.equal(w.state().uncertainAction,null);
  assert.notEqual(w.state().runId,"old-run");assert.equal(w.state().completed,0);
  assert.equal(w.sent.some(m=>m.type.startsWith("CHECK_")||m.type.startsWith("OPEN_")),false);
  assert.equal(w.state().lastAutoRecovery.taskKey,task.taskKey);
  assert.ok(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey));
  assert.equal(w.sent.some(m=>/REPLY|VERIFY|SUBMIT/.test(m.type)),false);
  assert.equal(w.stored[KEY].uncertainAction,null);
});
test("a running hung operation receives the same deadline recovery",async()=>{
  const w=await worker();w.state().running=true;w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,1);
});
test("manual stop wins even after twenty minutes",async()=>{
  const w=await worker();w.stop();w.advance(LIMIT*2);await w.tick();assert.equal(w.sent.length,0);assert.equal(w.scans.length,0);
});
for(const phase of ["cancel","reload","persist"]){
  test(`manual stop during ${phase} prevents continuation`,async()=>{
    const w=await worker();let fired=false;
    if(phase==="cancel")w.hooks.message=async m=>{if(m.type.startsWith("CANCEL_"))w.stop();};
    if(phase==="reload")w.hooks.reload=async()=>w.stop();
    if(phase==="persist")w.hooks.persist=async()=>{if(!fired){fired=true;w.stop();}};
    w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,0);assert.equal(w.state().manuallyStopped,true);
  });
}
for(const snapshot of [{activeCount:null},{activeCount:1},{invitationPending:true},{executionPresent:true},{runId:"other"},{recoveryId:"other"}]){
  test(`unconfirmed or active page cannot block the twenty-minute restart: ${JSON.stringify(snapshot)}`,async()=>{
    const w=await worker({snapshot});w.advance(LIMIT);await w.tick();assert.equal(w.reloads.length,1);assert.equal(w.scans.length,1);assert.ok(w.state().lastAutoRecovery.uncertainAction);assert.equal(w.state().uncertainAction,null);
  });
}
test("a missing cancellation receipt is recovered by unloading the old document",async()=>{
  const w=await worker({cancelOk:false});w.advance(LIMIT);await w.tick();assert.equal(w.reloads.length,1);assert.equal(w.scans.length,1);assert.ok(w.state().lastAutoRecovery.uncertainAction);
});
test("an unavailable official order check is not requested and cannot block restart",async()=>{
  const w=await worker();w.hooks.message=async m=>{if(m.type==="CHECK_LIGHTHOUSE_RECOVERY_STATE"&&w.reloads.length)throw Error("connection lost");};
  w.advance(LIMIT);await w.tick();assert.equal(w.reloads.length,1);assert.equal(w.scans.length,1);assert.ok(w.state().lastAutoRecovery.uncertainAction);
});
test("timeout recovery does not invent a verified completion from an elapsed timer",async()=>{
  const w=await worker({outcome:"completed"});w.advance(LIMIT);await w.tick();assert.equal(w.done.length,0);assert.equal(w.reloads.length,1);
  assert.equal(w.state().completionEvidence,null);assert.equal(w.state().completed,0);
});
test("a twenty-minute-old lock is excluded instead of replaying its original order",async()=>{
  const w=await worker({outcome:"locked",activeCount:1});w.advance(LIMIT);await w.tick();assert.deepEqual(w.scans,["after_twenty_minute_recovery"]);assert.equal(w.reloads.length,1);assert.ok(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey));
});
test("an unknown X post is archived and excluded while scanning resumes",async()=>{
  const w=await worker({outcome:"locked",activeCount:1});w.state().uncertainAction.type="RUN_X_REPLY";w.state().uncertainAction.tabId=22;w.state().xTabId=22;w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,1);assert.deepEqual(w.reloads,[22,11]);assert.equal(w.state().lastAutoRecovery.uncertainAction.type,"RUN_X_REPLY");assert.equal(w.sent.some(m=>/^(RUN_X_|COMPLETE_|SUBMIT_)/.test(m.type)),false);
});
test("concurrent alarms share one recovery and one marketplace restart",async()=>{
  const w=await worker();w.advance(LIMIT);await Promise.all([w.tick(),w.tick(),w.tick()]);assert.equal(w.reloads.length,1);assert.equal(w.scans.length,1);
});
test("worker restoration retains the original deadline and rearms its independent alarm",async()=>{
  const old=await worker();const saved=clone(old.state());
  const w=await worker({saved});assert.equal(w.state().autoRecovery.deadlineAt,saved.autoRecovery.deadlineAt);assert.ok(w.alarms.has(ALARM));
  w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,1);
});
for(const stage of ["finished","attempt_limit_reached","auto_waiting_schedule","ai_key_required","auto_blocked"]){
  test(`planned stop ${stage} disarms recovery`,async()=>{
    const w=await worker();w.c.setStage(stage);w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,0);assert.equal(w.state().autoRecovery,null);
  });
}

test("status polling and log messages never extend the task's twenty-minute deadline",async()=>{
  const w=await worker();const deadline=w.state().autoRecovery.deadlineAt;
  w.advance(LIMIT-100);w.c.setStage("action_result_unknown");w.c.log("info","still waiting");
  assert.equal(w.state().autoRecovery.deadlineAt,deadline);w.advance(100);await w.tick();assert.equal(w.scans.length,1);
});
test("failure to persist released intent rolls back to a protected stopped order",async()=>{
  const w=await worker();w.hooks.persist=async(values,cb)=>{if(!cb&&values[KEY]?.stage==="auto_timeout_reconciling"&&values[KEY].running===true&&!values[KEY].uncertainAction)throw Error("disk full");};
  w.advance(LIMIT);await w.tick();assert.ok(w.state().uncertainAction);assert.equal(w.state().running,false);assert.equal(w.scans.length,0);
});
test("STOP racing the final release checkpoint wins in memory and persisted storage",async()=>{
  const w=await worker();let stopped=false;
  w.hooks.persist=async(values,cb)=>{if(!stopped&&!cb&&values[KEY]?.running===true&&!values[KEY].uncertainAction){stopped=true;w.stop();}};
  w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,0);assert.equal(w.state().manuallyStopped,true);assert.equal(w.stored[KEY].manuallyStopped,true);
});
test("order counters after reload do not gate the time-based restart",async()=>{
  const snapshot={activeCount:0};const w=await worker({snapshot});w.hooks.reload=async()=>{snapshot.activeCount=1;};
  w.advance(LIMIT);await w.tick();assert.equal(w.scans.length,1);assert.ok(w.state().lastAutoRecovery.uncertainAction);
});
test("a different target cannot borrow an official completion receipt",async()=>{
  const w=await worker({outcome:"completed",activeCount:1,snapshot:{tweetUrl:"https://x.com/other/status/456"}});
  w.advance(LIMIT);await w.tick();assert.equal(w.done.length,0);assert.ok(w.state().lastAutoRecovery.uncertainAction);assert.equal(w.state().completed,0);
});
test("arming a new automatic run persists the exact twenty-minute deadline before scheduling",async()=>{
  const w=await worker();w.state().running=true;w.state().autoRecovery=null;
  await w.c.resetAutoRecoveryDeadline();
  assert.equal(w.state().autoRecovery.deadlineAt,1000000+LIMIT);
  assert.equal(w.stored[KEY].autoRecovery.deadlineAt,1000000+LIMIT);
  assert.equal(w.alarms.get(ALARM).when,1000000+LIMIT);
});
test("the real STOP command removes an armed recovery alarm and its persisted permission",async()=>{
  const w=await worker();w.state().running=true;await w.c.resetAutoRecoveryDeadline();
  await w.c.stopAndClearRun();assert.equal(w.alarms.has(ALARM),false);assert.equal(w.stored[KEY].manuallyStopped,true);
  w.advance(LIMIT*2);await w.tick();assert.equal(w.scans.length,0);
});
test("repeated worker restarts never reset the deadline or lose the automatic recovery mode",async()=>{
  const w=await worker();const deadline=w.state().autoRecovery.deadlineAt;
  const second=await worker({saved:clone(w.state())});
  const third=await worker({saved:clone(second.state())});
  assert.equal(third.state().autoRecovery.deadlineAt,deadline);
  third.advance(LIMIT);await third.tick();assert.equal(third.scans.length,1);
});
test("a newer run on the same state object cannot be stopped by a late recovery receipt",async()=>{
  const w=await worker();w.hooks.message=async m=>{if(m.type.startsWith("CANCEL_")){w.state().runId="newer-run";w.state().running=true;}};
  w.advance(LIMIT);await w.tick();assert.equal(w.state().runId,"newer-run");assert.equal(w.state().running,true);assert.equal(w.reloads.length,0);
});

for (const options of [{loadOk:false},{injectOk:false}]) {
  test(`browser recovery failure retains the task and schedules another attempt: ${JSON.stringify(options)}`, async()=>{
    const w=await worker(options);w.advance(LIMIT);await w.tick();
    assert.equal(w.scans.length,0);assert.equal(w.state().running,false);assert.ok(w.state().uncertainAction);
    assert.equal(w.alarms.get(ALARM).when,w.state().autoRecovery.nextAttemptAt);
  });
}
test("timeout dedupe survives a worker restart even after the old task is detached",async()=>{
  const w=await worker();w.advance(LIMIT);await w.tick();
  const restored=await worker({saved:clone(w.state())});
  assert.ok(restored.c.getActiveAttemptedTaskKeys().includes(task.taskKey));
  assert.equal(restored.state().lastAutoRecovery.taskKey,task.taskKey);
});
test("recovery refresh failures cannot lose the original action identity",async()=>{
  const w=await worker();w.state().xTabId=22;w.state().uncertainAction={type:"RUN_X_REPLY",runId:"old-run",tabId:22};
  w.hooks.reload=async()=>{throw Error("browser busy");};w.advance(LIMIT);await w.tick();
  assert.equal(w.scans.length,0);assert.equal(w.state().uncertainAction.type,"RUN_X_REPLY");
  assert.equal(w.state().lastAutoRecovery.uncertainAction.runId,"old-run");
});
test("a moved unrelated X page is not refreshed by recovery",async()=>{
  const w=await worker({tabs:{22:{url:"https://example.com/"}}});w.state().xTabId=22;
  w.advance(LIMIT);await w.tick();assert.deepEqual(w.reloads,[11]);assert.equal(w.scans.length,1);
});
test("manual stop during the X reset prevents the Lighthouse reset and next scan",async()=>{
  const w=await worker();w.state().xTabId=22;w.hooks.reload=async id=>{if(id===22)w.stop();};
  w.advance(LIMIT);await w.tick();assert.deepEqual(w.reloads,[22]);assert.equal(w.scans.length,0);
});
test("the twenty-minute reset preserves platform cooldown instead of bypassing it",async()=>{
  const w=await worker();w.state().claimRetryNotBefore=1000000+LIMIT+60000;
  w.advance(LIMIT);await w.tick();assert.equal(w.reloads.length,1);
  assert.equal(w.state().claimRetryNotBefore,1000000+LIMIT+60000);
});

test("recovery detaches stale worker promises so they cannot block a new flow",async()=>{
  const w=await worker();vm.runInContext('capturedTargetRecoveryPromise=new Promise(()=>{});directTweetOpenPromise=new Promise(()=>{});claimReconciliation=new Promise(()=>{})',w.c);
  w.advance(LIMIT);await w.tick();
  assert.equal(vm.runInContext('capturedTargetRecoveryPromise',w.c),null);
  assert.equal(vm.runInContext('directTweetOpenPromise',w.c),null);
  assert.equal(vm.runInContext('claimReconciliation',w.c),null);
});

async function nextClaim(w, claimTask, invitation = false) {
  const state=w.state();state.running=true;state.currentTask=invitation?null:claimTask;
  state.uncertainAction={type:"START_LIGHTHOUSE_COMMENT_TASK",runId:state.runId,tabId:11,intentId:"new-intent",
    checkpointRequired:true,checkpointVersion:1,contentInstanceId:"new-page",claimActionAttempted:false};
  const message={phase:"before_click",version:1,instanceId:"new-page",runId:state.runId,
    operationType:"START_LIGHTHOUSE_COMMENT_TASK",claimIntentId:"new-intent"};
  if(invitation)message.invitationTask=claimTask;
  return w.c.recordLighthouseClaimCheckpoint(message,{tab:{id:11},frameId:0});
}
test("a normal claim for the timeout task is rejected before its click checkpoint",async()=>{
  const w=await worker();w.advance(LIMIT);await w.tick();
  const result=await nextClaim(w,task);assert.equal(result.ok,false);assert.equal(w.state().uncertainAction.claimActionAttempted,false);
});
test("a repeated invitation using the canonical X URL cannot bypass timeout dedupe",async()=>{
  const w=await worker();w.advance(LIMIT);await w.tick();
  const url=w.c.normalizeTweetUrl(target,true);
  const result=await nextClaim(w,{source:"lighthouse_invitation",taskKey:`invitation:${url}`,tweetUrl:url,taskType:"评论",title:"Another title"},true);
  assert.equal(result.ok,false);assert.equal(w.state().uncertainAction.claimActionAttempted,false);
});
test("a different new order remains claimable after timeout recovery",async()=>{
  const w=await worker();w.advance(LIMIT);await w.tick();
  const result=await nextClaim(w,{taskKey:"order-456",tweetUrl:"https://x.com/new/status/456",title:"New order"});
  assert.equal(result.ok,true);assert.equal(result.permitClaimClick,true);
});
test("timeout exclusions expire after their recorded protection window",async()=>{
  const w=await worker();w.advance(LIMIT);await w.tick();w.advance(6*60*60*1000+1);
  const result=await nextClaim(w,task);assert.equal(result.ok,true);
});
test("timeout restart retains earlier pending verification records for the user",async()=>{
  const w=await worker();const records=[{taskKey:"earlier-pending",tweetUrl:"https://x.com/old/status/987"}];
  w.state().pendingVerifications=clone(records);w.advance(LIMIT);await w.tick();
  assert.deepEqual(clone(w.state().pendingVerifications),records);assert.equal(w.scans.length,1);
});
