'use strict';
const {app}=require('electron');const fs=require('fs'),path=require('path');
app.setName('mimitale');app.setPath('userData',path.join(app.getPath('appData'),'mimitale'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const {loadSettings,endpointFor}=require('../../client/main/providers.js');
 const {streamChat}=require('../../client/main/http.js');
 const settings=loadSettings();const results=[];
 for(const provider of settings.providers.filter(p=>new URL(p.baseUrl).hostname==='api.deepseek.com')){
  const model=provider.models.find(m=>m==='deepseek-flash');if(!model)continue;
  const start=Date.now();let firstMs=null,thinkingSent=null,streamSent=null,reasoningChars=0,deltaCount=0;
  try{const r=await streamChat({settings:{...endpointFor(settings,provider.id,model),maxTokens:2048,thinking:true},messages:[{role:'user',content:'Reply with only OK.'}],onRequest:body=>{thinkingSent=body.thinking?.type;streamSent=body.stream},onReasoning:text=>{reasoningChars+=text.length},onDelta:()=>{deltaCount++;if(firstMs===null)firstMs=Date.now()-start}});results.push({provider:provider.name,model,ok:!!r.content,contentChars:r.content.length,firstMs,elapsedMs:Date.now()-start,thinkingSent,streamSent,reasoningChars,deltaCount,finishReason:r.finishReason});}
  catch(e){results.push({provider:provider.name,model,ok:false,error:e.message,elapsedMs:Date.now()-start,thinkingSent});}
 }
 fs.writeFileSync(path.resolve('design/tavern/live-fix-verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));app.exit(results.every(r=>r.ok)?0:1);
}).catch(e=>{console.error(e.code||e.name);app.exit(1)});
