"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),Module=require("node:module");
const fixture=path.join(__dirname,"panel-stop-reset.test.cjs"),fixtureSource=fs.readFileSync(fixture,"utf8"),loaded=new Module(fixture,module);
loaded.filename=fixture;loaded._compile(fixtureSource.slice(0,fixtureSource.indexOf('test("STOP clears'))+"\nmodule.exports={panel,element,flush};",fixture);
const {panel,element,flush}=loaded.exports;
async function popup(){
  const nodes=new Map(),messages=[],hooks={};const node=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
  const settings={aiApiUrl:"https://api.vayne.cc.cd/v1/responses",aiApiKey:"fixture-session",aiModel:"chosen-model",aiSystemPrompt:"prompt",replyMode:"post",replyProvider:"native",actionDelayMs:500,maxTasksPerRun:1,autoSubmitLighthouse:true};
  const c=vm.createContext({console,URL,setInterval(){},document:{activeElement:null,getElementById:node,createElement:()=>element()},
    chrome:{windows:{getCurrent:async()=>({id:1})},runtime:{async sendMessage(message){messages.push(message);if(message.type==="GET_STATE")return{ok:true,settings,state:{logs:[]}};
      if(message.type==="SAVE_SETTINGS")return hooks.save?hooks.save(message):{ok:true,settings:message.settings};return{ok:true};}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/popup/popup.js"),"utf8"),c);await flush();return{c,node,messages,hooks};
}
for(const fault of ["response","missing","throw"]){
  const fail=()=>{if(fault==="throw")throw Error("会话保存失败");return fault==="missing"?undefined:{ok:false,error:"会话保存失败"};};
  test(`popup ${fault} save failure is visible and cannot START`,async()=>{
    const p=await popup();p.hooks.save=fail;await p.c.startRun();
    assert.equal(p.messages.some(m=>m.type==="START_RUN"),false);assert.match(p.node("saveStatus").textContent,/失败|未保存|没有确认/);
  });
  for(const flow of ["START_RUN","DEBUG_LOCK_SEAT_OPEN_TWEET","queue"]){
    test(`panel ${flow} ${fault} save failure never sends an action`,async()=>{
      const p=await panel({stopped:true});p.hooks.save=fail;p.hooks.action=()=>({ok:false,error:"fixture action boundary"});
      if(flow==="queue")await p.c.runStepQueue(0);else{const button=element();button.dataset.command=flow;await p.c.runSingleCommand(button);}
      assert.equal(p.messages.some(m=>m.type===flow||m.type.startsWith("DEBUG_")||m.type==="START_RUN"),false);
      assert.match(p.node("saveStatus").textContent,/失败|未保存|没有确认/);
      assert.equal(p.read("commandQueueRunning"),false);
    });
  }
}
test("popup successful save starts once and preserves virtual key/model fields",async()=>{
  const p=await popup();assert.equal(p.node("aiApiKey").value,"fixture-session");assert.equal(p.node("aiModel").value,"chosen-model");
  p.node("aiApiKey").value="fixture-new";await p.c.startRun();assert.equal(p.messages.filter(m=>m.type==="START_RUN").length,1);
  assert.equal(p.messages.find(m=>m.type==="SAVE_SETTINGS").settings.aiApiKey,"fixture-new");
});
test("panel explicit empty key is sent as an intentional clear and returns success",async()=>{
  const p=await panel({stopped:true});p.node("aiApiKey").value="";assert.equal(await p.c.saveSettings(),true);
  assert.equal(p.messages.find(m=>m.type==="SAVE_SETTINGS").settings.aiApiKey,"");
});
