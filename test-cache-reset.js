const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const tasks = require('./studocu-tasks.js');
const support = require('./studocu.js');
const asset='current', other='other';
const image=n=>`https://html.scribdassets.com/${asset}/images/${n}-hash.jpg`;
function storage(seed={}) {
  const data=structuredClone(seed),removed=[];
  return {data,removed,local:{async get(keys){return keys===null?structuredClone(data):Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,structuredClone(data[k])]))},
    async set(values){Object.assign(data,structuredClone(values));},async remove(keys){removed.push([...keys]);for(const k of keys)delete data[k];}}};
}
function content(store,{id='123',site='scribd',timers,setStatus=async()=>({ok:true,busy:true})}={}) {
  let listener, visible=[1,2];
  const root={querySelectorAll(selector){if(selector.startsWith('img,'))return visible.map(n=>({getAttribute:k=>k==='src'?image(n):null}));if(selector.includes('outer_page'))return[1,2].map(n=>({id:'outer_page_'+n}));return[];},querySelector(){return null;}};
  const context=vm.createContext({URL,Uint8Array,atob,btoa,setTimeout:timers?fn=>(timers.push(fn),timers.length):setTimeout,clearTimeout,performance:{getEntriesByType:()=>[]},console:{log(){}},
    document:{querySelector:s=>s==='#document_container'?root:null,querySelectorAll:()=>[],body:{scrollHeight:100},documentElement:{scrollHeight:100}},
    window:{location:{href:`https://www.scribd.com/document/${id}/example`},addEventListener(){},scrollTo(){throw Error('Must not scroll');}},
    chrome:{storage:{local:store.local},runtime:{onMessage:{addListener(fn){listener=fn}},sendMessage:setStatus}}});
  vm.runInContext(fs.readFileSync('content.js','utf8'),context);
  return {context,visible(n){visible=n;},send(m){return new Promise(resolve=>{let replied=false;listener(m,{},r=>{replied=true;resolve(r)});if(!replied&&m.action.includes('DocumentCacheReset'))setTimeout(()=>resolve(undefined),10);});}};
}
function background({seed={},site='scribd',busy=false,storageFailure=false,finishFailure=false,network}={}) {
  const store=storage(seed),messages=[],tabMessages=[];
  const tabs=site==='scribd'?[{id:7,url:'https://www.scribd.com/document/123/example'},{id:8,url:'https://www.scribd.com/document/123/example'},{id:9,url:'https://www.scribd.com/document/999/other'}]
    :[{id:7,url:'https://www.studocu.vn/vn/document/a/b/123'},{id:9,url:'https://www.studocu.vn/vn/document/a/b/999'}];
  const sources=new Map(tabs.filter(t=>site==='scribd').map(t=>[t.id,content(store,{id:t.id===9?'999':'123'})]));
  let listener;
  const context=vm.createContext({URL,Uint8Array,Buffer,atob,btoa,AbortController,setTimeout,clearTimeout,StudocuSupport:support,StudocuTasks:tasks,console:{log(){},error(){}},
    fetch:network||(async()=>{throw Error('Unexpected network');}),
    chrome:{storage:{local:{...store.local,async remove(keys){if(storageFailure)throw Error('storage unavailable');return store.local.remove(keys);}}},
      runtime:{onMessage:{addListener(fn){listener=fn}},sendMessage:async m=>{messages.push(m)}},
      tabs:{async query(){return tabs},sendMessage(tabId,m,cb){tabMessages.push({tabId,...m});
        if(busy&&tabId===8&&m.action==='prepareDocumentCacheReset')return cb({ok:false,status:'busy'});
        if(finishFailure&&m.action==='finishDocumentCacheReset')return cb({ok:false,error:'reset lost'});
        if(site==='studocu')return cb({ok:true,docId:'123',assetIds:[asset],resetId:m.resetId});
        sources.get(tabId).send(m).then(cb);
      }},downloads:{async download(){throw Error('Must not download while clearing cache')}}}});
  vm.runInContext(fs.readFileSync('background.js','utf8'),context);
  return {context,store,messages,tabMessages,sources,async send(m){assert.equal(typeof context.clearDocumentCache,'function','background must implement document-scoped cache reset');return new Promise(resolve=>listener({site,docId:'123',tabId:7,...m},{},resolve));}};
}

test('Scribd reset clears stored and live page cache in every matching tab, preserving other documents',async()=>{
  const h=background({seed:{'scribdScan:123':{version:1,docId:'123',assetId:asset,totalPages:2,urls:[image(1),image(2)]},'scribdScan:999':{keep:true},'studocuScan:123':{keep:true}}});
  for(const t of [7,8]){await h.sources.get(t).send({action:'getScanState'});h.sources.get(t).visible([1]);}
  const r=await h.send({action:'clearDocumentCache'});assert.equal(r.ok,true);
  assert.equal(h.store.data['scribdScan:123'],undefined);assert.deepEqual(h.store.data['scribdScan:999'],{keep:true});assert.deepEqual(h.store.data['studocuScan:123'],{keep:true});
  for(const t of [7,8])assert.equal((await h.sources.get(t).send({action:'getScanState'})).count,1);
  assert.equal(h.tabMessages.some(m=>m.tabId===9),false);
});
test('Scribd reset evicts only image and font buffers belonging to the current asset',async()=>{
  const h=background();await h.sources.get(7).send({action:'getScanState'});
  vm.runInContext(`fontDataUrlCache.set('https://html.scribdassets.com/current/fonts/0001.woff2','old');fontDataUrlCache.set('https://html.scribdassets.com/other/fonts/0001.woff2','keep');imageDataUrlCache.set('${image(1)}','old')`,h.context);
  assert.equal((await h.send({action:'clearDocumentCache'})).ok,true);
  assert.equal(vm.runInContext('fontDataUrlCache.size',h.context),1);assert.equal(vm.runInContext('imageDataUrlCache.size',h.context),0);
});
test('legacy single-document data is removed only when it belongs to the selected Scribd document',async()=>{
  for(const legacyId of ['123','999']){
    const h=background({seed:{docId:legacyId,collectedUrls:['old'],totalPages:2}});
    assert.equal((await h.send({action:'clearDocumentCache'})).ok,true);
    assert.equal(h.store.data.docId,legacyId==='123'?undefined:'999');
  }
});
test('a scan in another tab blocks deletion and releases already prepared tabs',async()=>{
  const h=background({busy:true,seed:{'scribdScan:123':{keep:true}}});
  const r=await h.send({action:'clearDocumentCache'});assert.equal(r.status,'busy');assert.equal(h.store.removed.length,0);
  assert.equal((await h.sources.get(7).send({action:'getScanState'})).count,2);
});
test('storage failure is reported without pretending success or leaving tabs locked',async()=>{
  const h=background({storageFailure:true,seed:{'scribdScan:123':{keep:true}}});
  const r=await h.send({action:'clearDocumentCache'});assert.equal(r.ok,false);assert.match(r.error,/storage/);
  assert.deepEqual(h.store.data['scribdScan:123'],{keep:true});assert.equal((await h.sources.get(7).send({action:'getScanState'})).count,2);
});

test('a rejected tab commit never reports a successful cache reset',async()=>{
  const h=background({site:'studocu',finishFailure:true});
  const r=await h.send({action:'clearDocumentCache'});
  assert.equal(r.ok,false);assert.match(r.error,/tải lại/);
});
test('a stale popup cannot clear another source document',async()=>{
  const h=background({seed:{'scribdScan:123':{keep:true}}});
  assert.equal((await h.send({action:'clearDocumentCache',docId:'999'})).ok,false);assert.equal(h.store.removed.length,0);
});
test('Studocu reset removes HTML, image manifest and completed task records, preserving download preference',async()=>{
  const completed={version:1,tabId:7,docId:'123',taskId:'old',status:'complete',assetId:asset,preference:'html'};
  const h=background({site:'studocu',seed:{'studocuScan:123':{assetId:asset},'studocuImages:123':{assetId:asset},'studocuMode:123':'html','studocuTask:7':completed,'studocuScan:999':{keep:true},'scribdScan:123':{keep:true}}});
  assert.equal((await h.send({action:'getStudocuTask'})).taskId,'old');
  assert.equal((await h.send({action:'clearDocumentCache'})).ok,true);
  for(const key of ['studocuScan:123','studocuImages:123','studocuTask:7'])assert.equal(h.store.data[key],undefined);
  assert.equal(h.store.data['studocuMode:123'],'html');assert.deepEqual(h.store.data['studocuScan:999'],{keep:true});
  assert.equal((await h.send({action:'getStudocuTask'})).taskId,undefined);
});
test('a reserved content cache rejects reads and scans until the reset finishes',async()=>{
  const store=storage(),h=content(store);await h.send({action:'getScanState'});
  const p=await h.send({action:'prepareDocumentCacheReset',site:'scribd',docId:'123',resetId:'R'});assert.equal(p?.ok,true);
  assert.equal((await h.send({action:'getScanState'})).ok,false);
  assert.equal((await h.send({action:'startScan'})).ok,false);
  assert.equal((await h.send({action:'finishDocumentCacheReset',docId:'123',resetId:'WRONG',commit:true})).ok,false);
  assert.equal((await h.send({action:'finishDocumentCacheReset',docId:'123',resetId:'R',commit:true})).ok,true);
  h.visible([1]);delete store.data['scribdScan:123'];assert.equal((await h.send({action:'getScanState'})).count,1);
});
test('content refuses reset while a scan is running',async()=>{
  const h=content(storage());vm.runInContext('isScanning=true',h.context);
  const r=await h.send({action:'prepareDocumentCacheReset',site:'scribd',docId:'123',resetId:'R'});assert.equal(r?.status,'busy');
});

test('reset reservation survives slow deletion and recovers only after the worker loses its lock',async()=>{
  const timers=[],store=storage();let busy=true;
  const h=content(store,{timers,setStatus:async()=>({ok:true,busy})});
  await h.send({action:'getScanState'});h.visible([1]);
  await h.send({action:'prepareDocumentCacheReset',site:'scribd',docId:'123',resetId:'R'});
  await timers.shift()();
  assert.equal((await h.send({action:'getScanState'})).ok,false,'cannot rehydrate old durable data during a slow reset');
  busy=false;delete store.data['scribdScan:123'];
  await timers.shift()();
  assert.equal((await h.send({action:'getScanState'})).count,1,'worker restart releases reservation with fresh memory');
});

test('reservation retries worker communication errors without exposing old cache',async()=>{
  const timers=[],h=content(storage(),{timers,setStatus:async()=>{throw Error('worker unavailable')}});
  await h.send({action:'prepareDocumentCacheReset',site:'scribd',docId:'123',resetId:'R'});
  await timers.shift()();
  assert.equal((await h.send({action:'getScanState'})).ok,false);assert.equal(timers.length,1);
  await h.send({action:'finishDocumentCacheReset',docId:'123',resetId:'R',commit:false});
});

test('late worker status cannot release a newer reset reservation',async()=>{
  const timers=[];let reply;
  const h=content(storage(),{timers,setStatus:()=>new Promise(resolve=>{reply=resolve})});
  await h.send({action:'prepareDocumentCacheReset',site:'scribd',docId:'123',resetId:'OLD'});
  const pending=timers.shift()();
  await h.send({action:'finishDocumentCacheReset',docId:'123',resetId:'OLD',commit:true});
  await h.send({action:'prepareDocumentCacheReset',site:'scribd',docId:'123',resetId:'NEW'});
  reply({ok:true,busy:false});await pending;
  assert.equal((await h.send({action:'getScanState'})).ok,false);
  await h.send({action:'finishDocumentCacheReset',docId:'123',resetId:'NEW',commit:true});
});

function popup({site='scribd',busy=false,clearError=false}={}) {
  const elements=new Map(),sent=[],listeners=[],writes=[];let ready;
  const state={docId:'123',site,totalPages:2,count:2,complete:true,ready:true,isScanning:false,urls:[image(1),image(2)],...(site==='studocu'?{mode:'html'}:{})};
  const context=vm.createContext({URL,console,document:{addEventListener(n,f){ready=f;},getElementById(id){if(!elements.has(id))elements.set(id,{style:{},disabled:true,textContent:'',innerHTML:'',classList:{add(){},remove(){}},events:{},addEventListener(n,f){this.events[n]=f},appendChild(c){this.innerHTML+=c.textContent}});return elements.get(id)},createElement:()=>({textContent:''})},
    StudocuSupport:site==='studocu'?support:undefined,
    chrome:{tabs:{async query(){return[{id:7,url:site==='scribd'?'https://www.scribd.com/document/123/x':'https://www.studocu.vn/vn/document/a/b/123'}]},sendMessage(id,m,cb){cb(m.action==='getDocInfo'?{docId:'123',totalPages:2}:state)}},storage:{local:{async get(){return{}},async set(value,callback){writes.push({value,callback})}}},runtime:{onMessage:{addListener(f){listeners.push(f)},removeListener(){}},async sendMessage(m){sent.push(m);if(m.action==='getDocumentCacheStatus')return{ok:true,busy};if(m.action==='clearDocumentCache')return clearError?{ok:false,error:'storage failed'}:{ok:true,clearedTaskIds:['OLD']};if(m.action==='getStudocuTask')return{active:false};return{};}}}});
  vm.runInContext(fs.readFileSync('popup.js','utf8'),context);
  return {elements,sent,listeners,writes,context,async open(){await ready();}};
}
test('Scribd scan completion leaves no legacy write callback that could download after reset',async()=>{
  const h=popup();await h.open();
  vm.runInContext('onScanComplete([],2,true)',h.context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.writes.length,0,'content owns persistence; popup must not leave an asynchronous legacy writer');
  assert.equal(h.sent.filter(m=>m.action==='downloadImages').length,1);
});
for(const site of ['scribd','studocu'])test(`${site} popup clears only the selected document then restores fresh readiness`,async()=>{
  const h=popup({site});await h.open();
  assert.equal(typeof h.elements.get('btn-clear-cache')?.events.click,'function');
  await h.elements.get('btn-clear-cache').events.click();
  const request=h.sent.find(m=>m.action==='clearDocumentCache');
  assert.equal(request.site,site);assert.equal(request.docId,'123');assert.equal(request.tabId,7);
  assert.equal(h.elements.get('btn-download').disabled,false);assert.match(h.elements.get('log').innerHTML,/cache/);
});
test('reopening the popup during a background download keeps cache deletion disabled',async()=>{
  const h=popup({busy:true});await h.open();assert.equal(h.elements.get('btn-clear-cache').disabled,true);
});
test('popup reports deletion failures and never claims cache was cleared',async()=>{
  const h=popup({clearError:true});await h.open();
  assert.equal(typeof h.elements.get('btn-clear-cache')?.events.click,'function');await h.elements.get('btn-clear-cache').events.click();
  assert.match(h.elements.get('log').innerHTML,/storage failed/);assert.doesNotMatch(h.elements.get('log').innerHTML,/Đã xóa/);
});
