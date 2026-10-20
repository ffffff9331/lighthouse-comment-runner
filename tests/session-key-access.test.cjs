"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const fixture=path.join(__dirname,"session-api-key.test.cjs"),source=fs.readFileSync(fixture,"utf8"),loaded=new Module(fixture,module);
loaded.filename=fixture;loaded._compile(source.slice(0,source.indexOf('test("legacy key'))+"\nmodule.exports={worker,deferred,flush,SESSION_KEY};",fixture);
const {worker,deferred,flush,SESSION_KEY}=loaded.exports;
test("every persistent key read locks local access to trusted extension contexts before reading keys",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-private"}}),events=[];
  w.chrome.storage.local.setAccessLevel=async options=>{events.push("access");assert.equal(options.accessLevel,"TRUSTED_CONTEXTS");};
  w.hooks.localGet=async keys=>{if(keys.includes(SESSION_KEY))events.push("read");};
  assert.equal((await w.c.getSettings()).aiApiKey,"fixture-private");assert.deepEqual(events,["access","read"]);
});
for(const kind of ["missing","failure"])test(`local access-level ${kind} fails explicitly and STOP remains available`,async()=>{
  const w=await worker();w.seed();let reads=0;w.hooks.localGet=async keys=>{if(keys.includes(SESSION_KEY))reads++;};
  if(kind==="missing")delete w.chrome.storage.local.setAccessLevel;
  else w.chrome.storage.local.setAccessLevel=async()=>{throw Error("fixture ACL failure");};
  await assert.rejects(w.c.getSettings(),/本地/);assert.equal(reads,0);assert.equal(w.writes.some(x=>x.area==="local"&&x.values.settings),false);
  assert.equal((await w.message("STOP_RUN")).ok,true);assert.equal(w.state().running,false);
});
test("old SAVE cannot add logs while a genuine new START waits for its settings",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-old"}});await w.c.getSettings();w.seed();const gate=deferred();let entered=false;
  w.hooks.localSet=async values=>{if(values[SESSION_KEY]==="fixture-new"){entered=true;await gate.promise;}};
  const saved=w.message("SAVE_SETTINGS",{aiApiKey:"fixture-new"});await flush();assert.equal(entered,true);await w.message("STOP_RUN");
  w.c.startNextAutoTask=async()=>({ok:true});const starting=w.message("START_RUN");await flush();assert.equal(w.state().running,true);
  gate.resolve();assert.equal((await saved).ok,true);assert.equal((await starting).ok,true);
  assert.equal(w.state().logs.some(x=>x.text==="配置已保存"),false);assert.equal(w.local[SESSION_KEY],"fixture-new");
});
