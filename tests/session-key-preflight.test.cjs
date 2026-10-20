"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),vm=require("node:vm");
const fixture=path.join(__dirname,"session-api-key.test.cjs"), source=fs.readFileSync(fixture,"utf8"), loaded=new Module(fixture,module);
const version=JSON.parse(fs.readFileSync(path.join(__dirname,"../manifest.json"),"utf8")).version;
loaded.filename=fixture;loaded._compile(source.slice(0,source.indexOf('test("legacy key'))+"\nmodule.exports={worker,deferred,flush,SESSION_KEY};",fixture);
const {worker:sessionWorker,deferred,flush,SESSION_KEY}=loaded.exports;
async function worker(...args){
  const w=await sessionWorker(...args),send=w.chrome.tabs.sendMessage;
  const manifest=w.chrome.runtime.getManifest();w.chrome.runtime.getManifest=()=>({...manifest,version});
  w.chrome.tabs.sendMessage=async(id,message)=>{
    if(message.type!=="CHECK_LIGHTHOUSE_RUNNER_READY")return send(id,message);
    w.actions.push({id,message:JSON.parse(JSON.stringify(message))});
    return{ok:true,version:w.chrome.runtime.getManifest().version,instanceId:"fixture-page",url:"https://app.lhdao.top/campaigns",paused:false};
  };
  return w;
}
const missing=/API Key|会话.*密钥/i;
const claims=w=>w.actions.filter(x=>/START_LIGHTHOUSE_COMMENT_TASK|LOCK|RUN_X_WIDGET_CLAIM|OPEN_SELECTED/.test(x.message?.type||""));

test("full auto start without a saved key fails before opening or claiming",async()=>{
  const w=await worker();let scans=0;w.c.startNextAutoTask=async()=>{scans++;return{ok:true};};
  const result=await w.c.startAutoRun({},1,true);assert.equal(result.ok,false);assert.match(result.error,missing);
  assert.equal(scans,0);assert.equal(w.actions.length,0);assert.equal(w.state().running,false);
});
test("full auto start with a saved key preserves the selectable model and starts normally",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-key"}});let scans=0;w.c.startNextAutoTask=async()=>{scans++;return{ok:true};};
  assert.equal((await w.c.startAutoRun({},1,true)).ok,true);assert.equal(scans,1);assert.equal((await w.c.getSettings()).aiModel,"fixture-user-model");
});
test("next auto scan without a saved key stops before sending another claim",async()=>{
  const w=await worker();w.seed();vm.runInContext("runtimeState.mode='auto';runtimeState.stage='campaigns_returned'",w.c);
  const result=await w.c.startNextAutoTask("missing-key");assert.equal(result.ok,false);assert.match(result.error,missing);assert.equal(claims(w).length,0);assert.equal(w.state().running,false);
});
for(const [name,invoke] of [
  ["debug lock",w=>w.c.debugLockSeatAndOpenTweet()],
  ["fast claim",w=>w.c.debugFastXClaimReplyVerify({taskType:"评论",taskKey:"fixture-order"},1)],
  ["selected run",w=>w.c.runSelectedCountdownTask({taskType:"评论",taskKey:"fixture-order"},1)]
])test(`${name} without key cannot send a claim`,async()=>{
  const w=await worker();w.seed();vm.runInContext("runtimeState.currentTask={taskType:'评论',taskKey:'fixture-order'}",w.c);
  const result=await invoke(w);assert.equal(result.ok,false);assert.match(result.error||result.message,missing);assert.equal(claims(w).length,0);
});
test("a known like-only debug lock does not require an AI key",async()=>{
  const w=await worker();w.seed();vm.runInContext("runtimeState.currentTask={taskType:'点赞',taskKey:'fixture-order'}",w.c);
  await w.c.debugLockSeatAndOpenTweet();assert.equal(claims(w).filter(x=>x.message.type==="DEBUG_LOCK_SEAT_AND_EXTRACT").length,1);
});
test("sola_bridge comment still requires key because this plugin generates the reply before bridge dispatch",async()=>{
  const w=await worker();w.local.settings.replyProvider="sola_bridge";w.seed();vm.runInContext("runtimeState.currentTask={taskType:'评论'}",w.c);
  const result=await w.c.debugLockSeatAndOpenTweet();assert.equal(result.ok,false);assert.match(result.error,missing);assert.equal(claims(w).length,0);
});
test("STOP remains usable while session storage is unavailable",async()=>{
  const w=await worker();w.seed();delete w.chrome.storage.session;
  const result=await w.message("STOP_RUN");assert.equal(result.ok,true);assert.equal(w.state().manuallyStopped,true);assert.equal(w.state().running,false);
});
test("STOP during preflight settings lookup prevents a late start or claim",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-key"}}),gate=deferred();let held=false;
  w.hooks.sessionGet=async()=>{if(!held){held=true;await gate.promise;}};
  const starting=w.c.startAutoRun({},1,true);await flush();assert.equal(held,true);assert.equal((await w.message("STOP_RUN")).ok,true);
  const stopped=JSON.stringify(w.state());gate.resolve();assert.equal((await starting).cancelled,true);assert.equal(JSON.stringify(w.state()),stopped);assert.equal(claims(w).length,0);
});
test("claim click checkpoint rechecks a lost key before authorizing a comment order",async()=>{
  const w=await worker();w.seed();vm.runInContext("runtimeState.currentTask={taskType:'评论'};runtimeState.uncertainAction={type:'DEBUG_LOCK_SEAT_AND_EXTRACT',runId:'fixture-run',tabId:11,intentId:'intent',checkpointRequired:true,checkpointVersion:1,contentInstanceId:'page',claimActionAttempted:false}",w.c);
  const result=await w.c.recordLighthouseClaimCheckpoint({version:1,phase:"before_click",runId:"fixture-run",operationType:"DEBUG_LOCK_SEAT_AND_EXTRACT",claimIntentId:"intent",instanceId:"page"},{tab:{id:11},frameId:0});
  assert.equal(result.ok,false);assert.match(result.error,missing);assert.equal(w.state().uncertainAction.claimActionAttempted,false);
});
