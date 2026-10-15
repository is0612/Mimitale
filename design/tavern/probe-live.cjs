'use strict';
const {app,safeStorage}=require('electron');
const fs=require('fs'),path=require('path'),https=require('https'),http=require('http');
app.setName('mimitale');
app.setPath('userData', path.join(app.getPath('appData'), 'mimitale'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const config=JSON.parse(fs.readFileSync(path.resolve('client/data/config.json'),'utf8'));
 const {decryptApiKey}=require('../../client/main/store.js');
 const {chatUrl}=require('../../client/main/http.js');
 const results=[];
 async function probe(provider,model){
  const start=Date.now();const report={provider:provider.name,model,events:[],status:null,contentChars:0,reasoningChars:0,done:false,ended:false,frames:0,bytes:0};
  return new Promise(resolve=>{
   let timer,doneTimer,settled=false,buffer='';
   const finish=reason=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(doneTimer);report.result=reason;report.elapsedMs=Date.now()-start;results.push(report);console.log(JSON.stringify(report));req.destroy();resolve();};
   const target=new URL(chatUrl(provider.baseUrl));
   const body=JSON.stringify({model,messages:[{role:'user',content:'Reply with only OK.'}],stream:false,max_tokens:512,temperature:0.7,thinking:{type:'disabled'}});
   const req=(target.protocol==='http:'?http:https).request(target,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream','User-Agent':'Mimitale/1.0',Authorization:`Bearer ${decryptApiKey(provider.apiKey)}`,'Content-Length':Buffer.byteLength(body)}},res=>{
    report.status=res.statusCode;report.contentType=res.headers['content-type'];report.headersMs=Date.now()-start;
    res.setEncoding('utf8');res.on('data',chunk=>{report.bytes+=Buffer.byteLength(chunk);buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line.startsWith('data:')){if(line && report.events.length<12)report.events.push({ms:Date.now()-start,kind:line.startsWith(':')?'comment':'other',text:line.replace(/[A-Za-z0-9_-]{40,}/g,'[redacted]').slice(0,180)});continue;}const data=line.slice(5).trim();if(data==='[DONE]'){report.done=true;report.doneMs=Date.now()-start;doneTimer=setTimeout(()=>finish('DONE but socket remains open after 3000ms'),3000);continue;}try{const json=JSON.parse(data);report.frames++;if(json.error)report.apiError={type:json.error.type,code:json.error.code};const choice=json.choices?.[0];const delta=choice?.delta||choice?.message||{};report.contentChars+=(delta.content||'').length;report.reasoningChars+=(delta.reasoning_content||'').length;if(choice?.finish_reason)report.finishReason=choice.finish_reason;if(!report.firstFrameMs)report.firstFrameMs=Date.now()-start;}catch{}}});
    res.on('end',()=>{report.ended=true;if(report.status===200){try{const json=JSON.parse(buffer);report.contentChars=(json.choices?.[0]?.message?.content||'').length;report.reasoningChars=(json.choices?.[0]?.message?.reasoning_content||'').length;report.finishReason=json.choices?.[0]?.finish_reason;}catch{}}if(report.status>=400){try{const j=JSON.parse(buffer);report.apiError={type:j.error?.type,code:j.error?.code};}catch{}}finish('end');});res.on('aborted',()=>finish('response aborted'));res.on('error',err=>finish('response error '+err.code));
   });req.on('error',err=>finish('network error '+(err.code||err.name)));timer=setTimeout(()=>finish('180s total timeout'),180000);req.end(body);
  });
 }
 await Promise.all(config.providers.filter(p=>new URL(p.baseUrl).hostname==='api.deepseek.com').flatMap(p=>(p.models||[]).filter(model=>model==='deepseek-flash').map(model=>probe(p,model))));
 fs.writeFileSync(path.resolve('design/tavern/live-service-report.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));app.exit(0);
}).catch(err=>{console.error(err.code||err.name);app.exit(1)});
