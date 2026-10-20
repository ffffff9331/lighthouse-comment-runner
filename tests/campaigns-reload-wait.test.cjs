"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const event={addListener(){}};
async function worker(options={}) {
 let now=1000000,active=true,reloads=0;const sent=[],stored={};
 class Clock extends Date {static now(){return now;}}
 const chrome={runtime:{getURL:p=>`chrome-extension://test/${p}`,getManifest:()=>({version:"test"}),onInstalled:event,onMessage:event},
 storage:{local:{async setAccessLevel(){},async get(keys){return Object.fromEntries(keys.map(k=>[k,stored[k]]));},async set(v,cb){Object.assign(stored,v);cb?.();}}},
 alarms:{onAlarm:event,async create(){},async clear(){}},tabs:{onCreated:event,onUpdated:event,onRemoved:event,
 async update(){},async reload(){reloads++;},async get(){if(options.missing)throw Error("No tab with id");return {id:11,url:options.url||"https://app.lhdao.top/campaigns",status:now-1000000>=(options.completeAt??Infinity)?"complete":"loading"};},
 async sendMessage(id,m){sent.push(m.type);assert.equal(m.type,"CHECK_LIGHTHOUSE_CAMPAIGNS_READY");
 if(options.stopOnRead)active=false;
 if(options.disconnect)throw Error("Receiving end does not exist");
 return {ok:true,ready:now-1000000>=(options.readyAt??10000),url:options.responseUrl||"https://app.lhdao.top/campaigns"};}}};
 const c=vm.createContext({chrome,Date:Clock,URL,AbortController,console,importScripts(){},setTimeout,clearTimeout});
 for(const f of ["reply-engine.js","background.js"])vm.runInContext(fs.readFileSync(path.join(__dirname,"../src",f),"utf8"),c);
 await vm.runInContext("runtimeStateReady",c);
 c.delay=async ms=>{now+=ms;if(options.stopAt&&now-1000000>=options.stopAt)active=false;};
 c.publishLighthouseMonitorSnapshot=()=>{};
 return {c,sent,elapsed:()=>now-1000000,reloads:()=>reloads,run:()=>c.reloadLighthouseCampaignsAfterOrder(11,"test",()=>active)};
}
test("loaded marketplace remains usable when Chrome still reports loading after ten seconds",async()=>{
 const w=await worker();assert.equal(await w.run(),true);assert.equal(w.reloads(),1);assert.deepEqual(w.sent,["CHECK_LIGHTHOUSE_CAMPAIGNS_READY"]);
});
test("slow resources that finish after the original ten-second cutoff do not permanently stop scanning",async()=>{
 const w=await worker({completeAt:22000,readyAt:Infinity});assert.equal(await w.run(),true);assert.equal(w.reloads(),1);assert.ok(w.elapsed()>=22000);
});
for(const options of [{readyAt:Infinity},{disconnect:true},{url:"https://example.com"},{responseUrl:"https://app.lhdao.top/campaigns/other"},{missing:true},{stopOnRead:true},{stopAt:5000}])
 test(`failed or cancelled reload cannot be reported ready: ${JSON.stringify(options)}`,async()=>{
  const w=await worker(options);assert.equal(await w.run(),false);assert.equal(w.reloads(),1);assert.ok(w.elapsed()<=65000);
 });

test("content readiness probe does not take over the active run or permit a claim",async()=>{
 let listener;const c=vm.createContext({console,URL,window:{addEventListener(){}},location:{href:"https://app.lhdao.top/campaigns"},
   chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}},async sendMessage(){return {ok:true,paused:false};}}}});
 const src=fs.readFileSync(path.join(__dirname,"../src/content/lighthouse.js"),"utf8"),end=src.lastIndexOf("})();");
 vm.runInContext(src.slice(0,end)+'isCampaignsListOpen=()=>true; activeRunId="original-run"; globalThis.fixtureState=()=>({activeRunId,claimOperation});'+src.slice(end),c);
 const dispatch=m=>{let r;listener(m,{},x=>r=x);return r;};
 assert.equal(dispatch({type:"CHECK_LIGHTHOUSE_CAMPAIGNS_READY",platform:"lighthouse"}).ready,true);
 assert.equal(c.fixtureState().activeRunId,"original-run");assert.equal(c.fixtureState().claimOperation,null);
 assert.equal(dispatch({type:"CHECK_LIGHTHOUSE_CAMPAIGNS_READY",platform:"other"}).ready,false);
 dispatch({type:"AUTOMATION_PAUSE_CHANGED",paused:true});
 assert.equal(dispatch({type:"CHECK_LIGHTHOUSE_CAMPAIGNS_READY",platform:"lighthouse"}).ready,false);
});
