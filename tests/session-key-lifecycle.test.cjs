"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),vm=require("node:vm");
const fixture=path.join(__dirname,"session-api-key.test.cjs"),source=fs.readFileSync(fixture,"utf8"),loaded=new Module(fixture,module);
loaded.filename=fixture;loaded._compile(source.slice(0,source.indexOf('test("legacy key'))+"\nmodule.exports={worker,deferred,flush,SESSION_KEY};",fixture);
const {worker,deferred,flush,SESSION_KEY}=loaded.exports;
for(const next of ["GET","SAVE"])test(`held old GET does not block newer ${next} and cannot overwrite it`,{timeout:1000},async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-old"}}),gate=deferred();let held=false;
  w.hooks.localGet=async keys=>{if(keys.length===1&&keys[0]==="settings"&&!held){held=true;await gate.promise;}};
  const old=w.c.getSettings();await flush();assert.equal(held,true);
  const fresh=next==="GET"?await w.c.getSettings():await w.c.saveSettingsToStorage({aiApiKey:"fixture-new",aiModel:"new-model"});
  assert.equal(fresh.aiApiKey,next==="GET"?"fixture-old":"fixture-new");gate.resolve();
  assert.equal((await old).aiApiKey,fresh.aiApiKey);assert.equal((await w.c.getSettings()).aiApiKey,fresh.aiApiKey);
});
test("GET read during a pending SAVE rechecks after the SAVE commits",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-old"}});await w.c.getSettings();const gate=deferred();let entered=false;
  w.hooks.localSet=async value=>{if(value[SESSION_KEY]==="fixture-new"){entered=true;await gate.promise;}};
  const saving=w.c.saveSettingsToStorage({aiApiKey:"fixture-new"});await flush();assert.equal(entered,true);
  const reading=w.c.getSettings();await flush();gate.resolve();await saving;assert.equal((await reading).aiApiKey,"fixture-new");
});
for(const entry of ["startAutoRun","debugLockSeatAndOpenTweet","debugFastXClaimReplyVerify","runSelectedCountdownTask"])test(`${entry} session read failure stops only its owned run`,async()=>{
  const w=await worker();if(entry!=="startAutoRun")w.seed();w.hooks.sessionGet=async()=>{throw Error("fixture unavailable");};
  await assert.rejects(w.c[entry]({taskKey:"fixture",taskType:"评论"},1,true),/会话/);
  assert.equal(w.state().running,false);assert.equal(w.state().stage,"settings_error");assert.equal(w.actions.length,0);
});
test("a late session failure after STOP and START cannot stop the new run",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-key"}}),gate=deferred();let held=false;
  w.hooks.sessionGet=async()=>{if(!held){held=true;await gate.promise;throw Error("fixture late failure");}};
  const old=w.c.startAutoRun({},1,true);await flush();await w.message("STOP_RUN");w.c.startNextAutoTask=async()=>({ok:true});
  assert.equal((await w.message("START_RUN")).ok,true);const stable=JSON.stringify(w.state());gate.resolve();
  await assert.rejects(old,/会话/);assert.equal(JSON.stringify(w.state()),stable);
});
test("install configures the toolbar panel even if session migration fails explicitly",async()=>{
  const w=await worker();let calls=0;w.chrome.sidePanel.setPanelBehavior=async config=>{assert.equal(config.openPanelOnActionClick,true);calls++;};
  w.hooks.sessionGet=async()=>{throw Error("fixture session unavailable");};
  await assert.rejects(w.events.install(),/会话/);assert.equal(calls,1);assert.equal((await w.message("STOP_RUN")).ok,true);
});
