"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),vm=require("node:vm");
const fixture=path.join(__dirname,"session-api-key.test.cjs"),source=fs.readFileSync(fixture,"utf8"),loaded=new Module(fixture,module);
loaded.filename=fixture;loaded._compile(source.slice(0,source.indexOf('test("legacy key'))+"\nmodule.exports={worker,deferred,flush,SESSION_KEY};",fixture);
const {worker,deferred,flush,SESSION_KEY}=loaded.exports;
for(const restart of [false,true])test(`a SAVE acknowledgement after STOP${restart?" and a new waiting run":""} saves settings without stale logs or schedule actions`,async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-old"}});await w.c.getSettings();w.seed();
  vm.runInContext("runtimeState.mode='auto';runtimeState.stage='auto_waiting_schedule'",w.c);
  const gate=deferred();let entered=false,scheduled=0;
  w.hooks.localSet=async value=>{if(value[SESSION_KEY]==="fixture-new"){entered=true;await gate.promise;}};
  w.c.reconcileWaitingAutoRunSchedule=async()=>{scheduled++;};
  const save=w.message("SAVE_SETTINGS",{aiApiKey:"fixture-new"});await flush();assert.equal(entered,true);
  assert.equal((await w.message("STOP_RUN")).ok,true);
  if(restart)vm.runInContext("runtimeState={...createInitialState(),runId:'new-waiting-run',running:true,mode:'auto',stage:'auto_waiting_schedule'}",w.c);
  const stable=JSON.stringify(w.state());gate.resolve();assert.equal((await save).ok,true);
  assert.equal(w.local[SESSION_KEY],"fixture-new");assert.equal(JSON.stringify(w.state()),stable);assert.equal(scheduled,0);
});
test("STOP retains the persistent key while clearing execution state",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-retained"}});await w.c.getSettings();w.seed();
  const settings=JSON.stringify(w.local.settings);await w.message("STOP_RUN");
  assert.equal(w.local[SESSION_KEY],"fixture-retained");assert.equal(JSON.stringify(w.local.settings),settings);assert.equal(w.state().manuallyStopped,true);
});
