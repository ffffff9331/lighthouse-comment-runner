"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path"), vm=require("node:vm");
// Kept as a fixture alias for the same key used by legacy session migration.
const SESSION_KEY="lighthouseAiApiKey";
const ENDPOINT="https://api.vayne.cc.cd/v1/responses";
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

// Actual complete worker; every Chrome/storage boundary is in-memory and all
// credentials below are deliberately synthetic. No real browser is accessed.
async function worker(options={}) {
  const local=clone(options.local||{}), session=clone(options.session||{}), writes=[], hooks={}, events={}, actions=[];
  const event=name=>({addListener(fn){events[name]=fn;}});
  const area=(name,values)=>({
    async setAccessLevel(){},
    async get(keys){await hooks[`${name}Get`]?.(keys);return Object.fromEntries(keys.filter(k=>Object.hasOwn(values,k)).map(k=>[k,clone(values[k])]));},
    async set(update,callback){await hooks[`${name}Set`]?.(update);writes.push({area:name,values:clone(update)});Object.assign(values,clone(update));callback?.();},
    async remove(keys){for(const k of [].concat(keys))delete values[k];}
  });
  const chrome={runtime:{id:"fixture",getURL:p=>`chrome-extension://fixture/${p}`,getManifest:()=>({version:"fixture"}),onInstalled:event("install"),onMessage:event("message"),sendMessage:async()=>({ok:true})},
    storage:{local:area("local",local),session:area("session",session)},
    alarms:{onAlarm:event("alarm"),create:async()=>{},clear:async()=>{}},
    tabs:{onCreated:event("created"),onUpdated:event("updated"),onRemoved:event("removed"),
      async get(id){return {id,windowId:1,status:"complete",url:"https://app.lhdao.top/campaigns"};},
      async query(){return[];},async create(value){actions.push({type:"create",value});return{id:11,windowId:1,...value};},
      async update(id,value){actions.push({type:"update",id,value});return{id,windowId:1,...value};},
      async sendMessage(id,message){actions.push({id,message:clone(message)});return{ok:false,claimActionAttempted:false,message:"fixture boundary"};}},
    windows:{get:async id=>({id})},sidePanel:{setPanelBehavior:async()=>{}},scripting:{executeScript:async()=>[]}};
  const c=vm.createContext({chrome,console,URL,AbortController,importScripts(){},setTimeout(){return 0;},clearTimeout(){},fetch:async()=>{throw Error("Network forbidden");}});
  for(const file of ["reply-engine.js","background.js"])vm.runInContext(fs.readFileSync(path.join(__dirname,"../src",file),"utf8"),c,{filename:file});
  await vm.runInContext("runtimeStateReady",c);await flush();
  Object.assign(c,{publishLighthouseMonitorSnapshot(){},delay:async()=>{},waitForTabComplete:async()=>true,
    getOrCreateLighthouseTab:async()=>({id:11,windowId:1,url:"https://app.lhdao.top/campaigns"}),
    resolveLighthouseTab:async()=>11,rememberLighthouseTabById:async()=>{},focusLighthouseTabForAutoScan:async()=>true,
    ensureLighthouseAlertBridge:async()=>{},ensurePermanentIgnoredTaskKeysLoaded:async()=>{},
    closeLighthouseTaskDetail:async()=>{},openSelectedTaskTweetTab:async()=>11,openNextLighthouseTaskTweetTab:async()=>11});
  if(!Object.hasOwn(local,"settings"))local.settings=clone(vm.runInContext("({...DEFAULT_SETTINGS, aiApiUrl:'https://api.vayne.cc.cd/v1/responses', aiModel:'fixture-user-model', aiSystemPrompt:'fixture-user-prompt'})",c));
  const message=(type,settings)=>c.handleMessage({type,settings,clientWindowId:1},{id:"fixture",url:"chrome-extension://fixture/src/debug/debug.html"});
  return{c,chrome,local,session,writes,hooks,events,actions,message,
    state:()=>vm.runInContext("runtimeState",c),seed:()=>vm.runInContext("Object.assign(runtimeState,{running:true,mode:'debug',runId:'fixture-run',runtimeWindowId:1,lighthouseTabId:11})",c)};
}
const legacy=key=>({settingsVersion:14,aiApiUrl:ENDPOINT,aiApiKey:key,aiModel:"fixture-model",aiSystemPrompt:"custom prompt",replyMode:"post",autoSubmitLighthouse:true});
function assertNoSettingsKey(w){for(const write of w.writes)if(write.area==="local"&&write.values.settings)assert.equal(Object.hasOwn(write.values.settings,"aiApiKey"),false);assert.equal(Object.hasOwn(w.local.settings,"aiApiKey"),false);}

test("legacy key moves to dedicated local storage before settings cleanup and GET keeps settings/model compatible",async()=>{
  const w=await worker({local:{settings:legacy("fixture-legacy")}});const result=await w.c.getSettings();
  assert.equal(result.aiApiKey,"fixture-legacy");assert.equal(result.aiModel,"fixture-model");assert.equal(result.aiSystemPrompt,"custom prompt");
  assert.equal(w.local[SESSION_KEY],"fixture-legacy");assertNoSettingsKey(w);
  const keyWrite=w.writes.findIndex(e=>e.area==="local"&&Object.hasOwn(e.values,SESSION_KEY));const localWrite=w.writes.findIndex(e=>e.area==="local"&&e.values.settings);
  assert.ok(keyWrite>=0&&keyWrite<localWrite);
});
for(const existing of ["fixture-session",""]){
  test(`existing session value wins over local legacy key (${existing?"nonempty":"explicit clear"})`,async()=>{
    const w=await worker({local:{settings:legacy("fixture-old")},session:{[SESSION_KEY]:existing}});
    assert.equal((await w.c.getSettings()).aiApiKey,existing);assert.equal(w.local[SESSION_KEY],existing);assertNoSettingsKey(w);
  });
}
test("legacy key for a foreign endpoint is discarded rather than migrated as usable",async()=>{
  const w=await worker({local:{settings:{...legacy("fixture-foreign"),aiApiUrl:"https://foreign.invalid/v1"}}});
  assert.equal((await w.c.getSettings()).aiApiKey,"");assertNoSettingsKey(w);assert.notEqual(w.local[SESSION_KEY],"fixture-foreign");
});
test("failed migration key write leaves legacy settings key intact and returns an error",async()=>{
  const w=await worker({local:{settings:legacy("fixture-retained")}});w.hooks.localSet=async()=>{throw Error("fixture persistent key write failed");};
  await assert.rejects(w.c.getSettings(),/本地|保存/i);assert.equal(w.local.settings.aiApiKey,"fixture-retained");
  assert.equal(w.writes.some(e=>e.area==="local"&&e.values.settings),false);
});
test("failed settings cleanup never loses the successfully persisted dedicated key",async()=>{
  const w=await worker({local:{settings:legacy("fixture-retained")}});w.hooks.localSet=async value=>{if(value.settings)throw Error("fixture local cleanup failed");};
  await assert.rejects(w.c.getSettings(),/local|cleanup|保存/i);assert.equal(w.local[SESSION_KEY],"fixture-retained");
  delete w.hooks.localSet;assert.equal((await w.c.getSettings()).aiApiKey,"fixture-retained");assertNoSettingsKey(w);
});
for(const fault of ["missing","read"]){
  test(`dedicated local ${fault} error is explicit and never falls back to legacy credentials`,async()=>{
    const w=await worker({local:{settings:legacy("fixture-secret")}});
    if(fault==="missing")delete w.chrome.storage.local.get;else w.hooks.localGet=async keys=>{if(keys.includes(SESSION_KEY))throw Error("fixture local key read failed");};
    await assert.rejects(w.c.getSettings(),/本地|保存/i);assert.equal(w.local.settings.aiApiKey,"fixture-secret");
  });
}
test("SAVE without key preserves persistent key and omitted settings; explicit blank clears using a tombstone",async()=>{
  const w=await worker({local:{settings:legacy("fixture-old")},session:{[SESSION_KEY]:"fixture-current"}});
  const saved=await w.message("SAVE_SETTINGS",{actionDelayMs:2000});
  assert.equal(saved.ok,true);assert.equal(saved.settings.aiApiKey,"fixture-current");assert.equal(saved.settings.aiModel,"fixture-model");
  assert.equal(saved.settings.actionDelayMs,2000);assertNoSettingsKey(w);
  await w.message("SAVE_SETTINGS",{aiApiKey:"   "});assert.equal(w.local[SESSION_KEY],"");
  w.local.settings.aiApiKey="fixture-stale";assert.equal((await w.c.getSettings()).aiApiKey,"");assertNoSettingsKey(w);
});
test("SAVE stores a newly entered virtual key in a dedicated local item",async()=>{
  const w=await worker();const saved=await w.message("SAVE_SETTINGS",{aiApiKey:" fixture-new ",aiModel:"selected-model"});
  assert.equal(saved.settings.aiApiKey,"fixture-new");assert.equal(saved.settings.aiModel,"selected-model");assert.equal(w.local[SESSION_KEY],"fixture-new");assertNoSettingsKey(w);
});
test("SAVE key write failure rejects and preserves the prior key and settings",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-current"}});await w.c.getSettings();const before=clone(w.local.settings);
  w.hooks.localSet=async()=>{throw Error("fixture persistent key write failed");};
  await assert.rejects(w.message("SAVE_SETTINGS",{aiApiKey:"fixture-new",aiModel:"changed"}),/本地|保存/i);
  assert.deepEqual(w.local.settings,before);assert.equal(w.local[SESSION_KEY],"fixture-current");assertNoSettingsKey(w);
});
test("GET migration and concurrent SAVE share one serial queue; newest explicit key wins",async()=>{
  const gate=deferred();const w=await worker({local:{settings:legacy("fixture-old")}});let entered=false;
  w.hooks.localSet=async value=>{if(value[SESSION_KEY]==="fixture-old"){entered=true;await gate.promise;}};
  const reading=w.c.getSettings();await flush();assert.equal(entered,true);
  const saving=w.message("SAVE_SETTINGS",{aiApiKey:"fixture-new",aiModel:"new-model"});await flush();
  assert.equal(w.writes.some(e=>e.area==="local"&&e.values.settings),false);gate.resolve();
  await Promise.all([reading,saving]);assert.equal((await w.c.getSettings()).aiApiKey,"fixture-new");assert.equal(w.local.settings.aiModel,"new-model");assertNoSettingsKey(w);
});
test("concurrent SAVE calls preserve invocation order and an explicit final clear",async()=>{
  const gate=deferred();const w=await worker({session:{[SESSION_KEY]:"fixture-existing"}});await w.c.getSettings();let entered=false;
  w.hooks.localSet=async value=>{if(value[SESSION_KEY]==="fixture-first"){entered=true;await gate.promise;}};
  const first=w.message("SAVE_SETTINGS",{aiApiKey:"fixture-first",aiModel:"first-model"});await flush();assert.equal(entered,true);
  const last=w.message("SAVE_SETTINGS",{aiApiKey:"",aiModel:"last-model"});await flush();gate.resolve();await Promise.all([first,last]);
  assert.equal(w.local[SESSION_KEY],"");assert.equal(w.local.settings.aiModel,"last-model");assertNoSettingsKey(w);
});
test("a failed queued operation does not poison subsequent explicit saves",async()=>{
  const w=await worker();w.hooks.localSet=async()=>{throw Error("fixture persistent key failure");};
  await assert.rejects(w.message("SAVE_SETTINGS",{aiApiKey:"fixture-bad"}),/本地|保存/i);
  delete w.hooks.localSet;assert.equal((await w.message("SAVE_SETTINGS",{aiApiKey:"fixture-good"})).ok,true);assert.equal(w.local[SESSION_KEY],"fixture-good");assertNoSettingsKey(w);
});
test("legacy session clearing cannot remove the persistent key",async()=>{
  const w=await worker({local:{settings:legacy("fixture-once")}});await w.c.getSettings();delete w.session[SESSION_KEY];
  assert.equal((await w.c.getSettings()).aiApiKey,"fixture-once");assertNoSettingsKey(w);
});
test("install initialization writes public settings only and content receives no key",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-private"}});delete w.local.settings;await w.events.install();assertNoSettingsKey(w);
  const reply=await w.message("GET_CONTENT_SETTINGS");assert.equal(reply.ok,true);assert.equal(Object.hasOwn(reply.settings,"aiApiKey"),false);
});
test("trusted UI GET returns the persistent key without copying it to runtime state",async()=>{
  const w=await worker({session:{[SESSION_KEY]:"fixture-ui-key"}});const reply=await w.message("GET_STATE");
  assert.equal(reply.settings.aiApiKey,"fixture-ui-key");assert.equal(JSON.stringify(reply.state).includes("fixture-ui-key"),false);assertNoSettingsKey(w);
});

for (const scenario of [
  { name: "successful replacement", key: "fixture-replacement", failLocal: false },
  { name: "explicit clear", key: "", failLocal: false },
  { name: "dedicated key saved but ordinary settings rejected", key: "fixture-partial", failLocal: true }
]) {
  test(`a delayed GET rebases after ${scenario.name}`, async () => {
    const w = await worker({ session: { [SESSION_KEY]: "fixture-before" } });
    await w.c.getSettings();
    const before = clone(w.local.settings);
    const entered = deferred(), release = deferred();
    const readLocal = w.chrome.storage.local.get;
    let captureOnce = true;
    w.chrome.storage.local.get = async keys => {
      const snapshot = await readLocal(keys);
      if (keys.includes(SESSION_KEY) && captureOnce) {
        captureOnce = false;
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    };
    const reading = w.c.getSettings();
    await entered.promise;
    if (scenario.failLocal) w.hooks.localSet = async values => {
      if (values.settings) throw Error("fixture local save failure");
    };
    try {
      const saving = w.message("SAVE_SETTINGS", { aiApiKey: scenario.key, aiModel: "replacement-model" });
      if (scenario.failLocal) await assert.rejects(saving, /local save failure/);
      else assert.equal((await saving).ok, true);
    } finally {
      delete w.hooks.localSet;
      release.resolve();
    }
    const refreshed = await reading;
    assert.equal(refreshed.aiApiKey, scenario.key, "an old snapshot must not resurrect the previous credential");
    assert.equal(w.local[SESSION_KEY], scenario.key);
    assert.equal(refreshed.aiModel, scenario.failLocal ? before.aiModel : "replacement-model");
    if (scenario.failLocal) assert.deepEqual(w.local.settings, before);
    assertNoSettingsKey(w);
  });
}
