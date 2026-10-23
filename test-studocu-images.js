const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const support = require('./studocu.js');
const asset = '751f3cf5c60a97b3cc8ac28081c5b21f';
const docId = '156142723';
const base = `https://doc-assets.studocu.com/${asset}/html/`;
function signed(page=1, {resource=base+'*.png', expiry=Math.floor(Date.now()/1000)+3600, signature='sig~_-__'}={}) {
  const policy = Buffer.from(JSON.stringify({Statement:[{Resource:resource,Condition:{DateLessThan:{'AWS:EpochTime':expiry}}}]})).toString('base64').replaceAll('+','-').replaceAll('=','_').replaceAll('/','~');
  return `${base}bg${page.toString(16)}.png?Policy=${policy}&Signature=${signature}&Key-Pair-Id=KEY`;
}
function reader({total=116, metadataId=docId, notice='', samples=[1,8,10,16], cache={}}={}) {
  const stored=structuredClone(cache), scrolls=[];
  let sourceOptions={};
  const nodes=samples.map(n=>({
    getAttribute:name=>name==='data-page-index'?String(n-1):null,
    querySelector:selector=>selector==='.pf'?{size:{width:n===1?'842.04px':'595px',height:n===1?'595.44px':'842px'}}:null,
    querySelectorAll:selector=>selector==='img'?[{get currentSrc(){return signed(n,sourceOptions);},get src(){return signed(n,sourceOptions);}}]:[],
    scrollIntoView(){scrolls.push(n);}
  }));
  const root={parentElement:{innerText:notice},querySelectorAll:selector=>selector==='[data-page-index]'?nodes:[]};
  const document={querySelector:selector=>selector==='#document-wrapper'?root:selector==='#__NEXT_DATA__'?{textContent:JSON.stringify({props:{pageProps:{document:{id:Number(metadataId),numberOfPages:total},relatedDocuments:[{id:111,numberOfPages:999}]}}})}:null};
  const window={location:{href:`https://www.studocu.vn/vn/document/school/course/name/${docId}`},getComputedStyle:node=>node.size||{},scrollTo(){throw new Error('Must not scroll');}};
  const chrome={storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,structuredClone(stored[k])]));},async set(value){Object.assign(stored,structuredClone(value));}}}};
  return {document,window,chrome,stored,scrolls,nodes,source(options){sourceOptions=options;}};
}

test('direct manifest reads the current document metadata and generates all 116 exact signed URLs without loaded HTML',()=>{
  assert.equal(typeof support.readImageManifest,'function');
  const h=reader(),m=support.readImageManifest(h.document,h.window);
  assert.equal(m.ready,true);assert.equal(m.totalPages,116);assert.equal(m.docId,docId);assert.equal(m.assetId,asset);
  assert.equal(m.pages.length,116);
  for(const n of [1,9,10,16,116])assert.equal(m.pages[n-1].url,signed(n));
  assert.equal(new URL(m.pages[115].url).pathname,`/${asset}/html/bg74.png`);
  assert.equal(m.pages[0].pdfWidth,842.04);assert.equal(m.pages[0].pdfHeight,595.44);
  assert.equal(h.scrolls.length,0);
});
test('direct manifest never borrows the page count of recommendations or guesses the end from loaded frames',()=>{
  assert.equal(typeof support.readImageManifest,'function');
  const h=reader({metadataId:'123'});
  assert.equal(support.readImageManifest(h.document,h.window).ready,false);
  h.document.querySelector('#document-wrapper').parentElement.innerText='Go Premium and unlock all 116 pages';
  assert.equal(support.readImageManifest(h.document,h.window).ready,false);
  const query=h.document.querySelector;
  h.document.querySelector=selector=>selector==='#__NEXT_DATA__'?null:query(selector);
  assert.equal(support.readImageManifest(h.document,h.window).totalPages,116);
});
test('SPA URL changes never combine another document ID with stale metadata and image DOM',()=>{
  const h=reader({total:2,samples:[1],notice:'Unlock all 2 pages'});
  h.window.location.href='https://www.studocu.vn/vn/document/a/b/999';
  const m=support.readImageManifest(h.document,h.window);
  assert.equal(m.ready,false);assert.match(m.error,/thay đổi|tài liệu/i);
});
test('direct manifest rejects expired, narrow or other-document policies and non-hexadecimal page mapping',()=>{
  assert.equal(typeof support.readImageManifest,'function');
  for(const options of [{expiry:1},{resource:base+'bg1.png'},{resource:base.replace(asset,'a'.repeat(32))+'*.png'}]){
    const h=reader();h.source(options);assert.equal(support.readImageManifest(h.document,h.window).ready,false);
  }
  const h=reader({samples:[1,10]});
  h.nodes[1].querySelectorAll=()=>[{src:signed(16),currentSrc:signed(16)}];
  assert.equal(support.readImageManifest(h.document,h.window).ready,false);
});
test('image controller caches readiness but renews the signed source from current DOM without scrolling',async()=>{
  assert.equal(typeof support.createImageController,'function');
  const h=reader(),c=support.createImageController(h);
  const state=await c.inspect();assert.equal(state.mode,'images');assert.equal(state.ready,true);assert.equal(state.complete,false);
  assert.equal(Object.keys(h.stored).some(k=>k.startsWith('studocuImages:')),true);
  h.source({signature:'NEW~__'});
  const m=await c.getManifest({docId});assert.equal(m.pages[8].url,signed(9,{signature:'NEW~__'}));
  assert.equal(h.scrolls.length,0);
  h.window.location.href='https://www.studocu.vn/vn/document/a/b/99';
  await assert.rejects(c.getManifest({docId}),/tài liệu|thay đổi/i);
});

const pngHeader=Buffer.from([137,80,78,71,13,10,26,10]);
const jpegHeader=Buffer.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
function workerHarness({total=12,behavior=()=>200,renew=false,navigateOnRender=false,deferSave=false}={}) {
  const h=reader({total,samples:[1]}),fetches=[],downloads=[],messages=[],renders=[],updates=[],removed=[];
  let listener,active=0,maximum=0,manifests=0,releaseSave,saveStarted;
  const saving=new Promise(resolve=>{saveStarted=resolve;});
  const scope=vm.createContext({console:{log(){}},URL,Uint8Array,Buffer,atob,btoa,StudocuSupport:support,AbortController,setTimeout,clearTimeout,
    fetch:async(url,options={})=>{
      const pageNum=parseInt(new URL(url).pathname.match(/bg([a-f0-9]+)\.png$/)[1],16);
      const attempt=fetches.filter(f=>f.pageNum===pageNum).length+1;
      fetches.push({url,pageNum,attempt,signal:options.signal});active++;maximum=Math.max(maximum,active);
      try {
        await new Promise((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{name:'AbortError'}));};
          const timer=setTimeout(()=>{options.signal?.removeEventListener('abort',abort);resolve();},(total-pageNum)%4+2);
          if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
        });
        const status=await behavior({url,pageNum,attempt});
        if(status==='network')throw new TypeError('network unavailable');
        return{ok:status===200||status==='xml',status:status==='xml'?200:status,headers:{get:()=>status==='xml'?'application/xml':'image/png'},
          arrayBuffer:async()=>Uint8Array.from(status==='xml'?Buffer.from('<Error>Denied</Error>'):Buffer.concat([pngHeader,Buffer.from('_PAGE_'+pageNum+'_')])).buffer};
      }finally{active--;}
    },chrome:{runtime:{lastError:null,onMessage:{addListener(fn){listener=fn;}},sendMessage(message){messages.push(message);return Promise.resolve();}},
      downloads:{async download(value){downloads.push(value);saveStarted();if(deferSave)await new Promise(resolve=>{releaseSave=resolve;});return 9;}},tabs:{onUpdated:{addListener(fn){updates.push(fn);}},onRemoved:{addListener(fn){removed.push(fn);}},
        sendMessage(tabId,request,callback){
          if(tabId!==8)throw new Error('Wrong tab');
          if(request.action==='getStudocuImageManifest'){
            manifests++;if(renew&&manifests>1)h.source({signature:'RENEWED~__'});
            return callback(support.readImageManifest(h.document,h.window));
          }
          if(request.action==='getScanState')return callback({site:'studocu',mode:'images',docId,totalPages:total,ready:true,complete:false,isScanning:false});
          if(request.action==='renderStudocuImage'){
            renders.push(request);
            if(navigateOnRender&&renders.length===1)updates.forEach(fn=>fn(8,{url:'https://www.studocu.vn/vn/document/a/b/99'}));
            return callback({ok:true,pageNum:request.pageNum,dataUrl:'data:image/jpeg;base64,'+Buffer.concat([jpegHeader.subarray(0,-2),Buffer.from('_PAGE_'+request.pageNum+'_'),jpegHeader.subarray(-2)]).toString('base64'),width:600,height:800});
          }
          throw new Error('Unexpected content action '+request.action);
        }}}});
  vm.runInContext(fs.readFileSync('./background.js','utf8'),scope);
  const send=request=>new Promise(resolve=>listener(request,{},resolve));
  return {fetches,downloads,messages,renders,updates,removed,get maximum(){return maximum;},get manifests(){return manifests;},
    run:()=>send({action:'downloadImages',site:'studocu',mode:'images',docId,expectedPages:total,tabId:8}),
    stop:()=>send({action:'stopStudocuDownload',docId,tabId:8}),state:()=>send({action:'getStudocuDownloadState',docId,tabId:8}),saving,releaseSave:()=>releaseSave()};
}
test('direct worker fetches at most four images concurrently, renders once and writes the complete PDF in page order',async()=>{
  const h=workerHarness();await h.run();
  assert.equal(h.downloads.length,1);assert.equal(h.fetches.length,12);assert.equal(h.maximum,4);
  assert.equal(h.downloads[0].filename,`studocu_${docId}/document.pdf`);
  const pdf=Buffer.from(h.downloads[0].url.split(',')[1],'base64').toString('latin1');
  assert.match(pdf,/\/Count 12\b/);assert.match(pdf,/\/MediaBox \[0 0 842\.04 595\.44\]/);
  for(let n=1;n<12;n++)assert.ok(pdf.indexOf('_PAGE_'+n+'_')<pdf.indexOf('_PAGE_'+(n+1)+'_'));
  assert.equal(h.renders.length,12);assert.ok(h.renders.every(r=>!r.html&&!r.fontCss));
  assert.equal(h.messages.filter(m=>m.action==='downloadComplete').length,1);
  const state=await h.state();assert.equal(state.active,false);assert.equal(state.downloadedCount,12);
});

test('Studocu image jobs publish detailed stages and clear them when export completes',async()=>{
  const h=workerHarness({total:2});await h.run();
  const state=h.messages.filter(m=>m.action==='documentActivityUpdated').at(-1);
  assert.ok(state,'download details must be available without a popup');
  for(const stage of ['document_check','images','render','pdf','saving']){
    assert.ok(state.logs.some(l=>l.event==='stageStart'&&l.stage===stage),stage);
    assert.ok(state.logs.some(l=>l.event==='stageComplete'&&l.stage===stage&&l.elapsedMs>=0),stage);
  }
  assert.equal(state.activeStages.length,0);assert.equal(state.active,false);
  assert.equal(h.downloads.length,1);assert.equal(h.maximum,2);
});
test('direct worker retries network errors and HTTP 5xx only once',async()=>{
  for(const first of ['network',503]){
    const h=workerHarness({total:2,behavior:({pageNum,attempt})=>pageNum===1&&attempt===1?first:200});await h.run();
    assert.equal(h.downloads.length,1);assert.equal(h.fetches.filter(f=>f.pageNum===1).length,2);
  }
});
test('401/403 refresh uses one shared fresh manifest and never scrolls or retries unchanged tokens',async()=>{
  const h=workerHarness({total:8,renew:true,behavior:({url})=>url.includes('RENEWED')?200:403});await h.run();
  assert.equal(h.downloads.length,1);assert.equal(h.manifests,3); // initial, shared renewal, final identity check
  const stale=workerHarness({total:2,behavior:()=>401});await stale.run();
  assert.equal(stale.downloads.length,0);assert.equal(stale.manifests,2);
  assert.match(stale.messages.find(m=>m.action==='downloadError').error,/tải lại tab/i);
});
test('404, invalid image bytes and exhausted retries never create a partial PDF or claim success',async()=>{
  for(const failure of [404,'xml',503]){
    const h=workerHarness({total:8,behavior:({pageNum})=>pageNum===2?failure:200});await h.run();
    assert.equal(h.downloads.length,0);assert.equal(h.messages.some(m=>m.action==='downloadComplete'),false);
    assert.match(h.messages.find(m=>m.action==='downloadError').error,/trang 2/i);
    if(failure===404)assert.equal(h.fetches.filter(f=>f.pageNum===2).length,1);
  }
});
test('duplicate jobs are refused and Stop aborts in-flight fetches without exporting a PDF',async()=>{
  const h=workerHarness({total:116}),first=h.run();
  const duplicate=await h.run();assert.equal(duplicate.status,'busy');
  const live=await h.state();assert.equal(live.active,true);
  if(!h.fetches.length)await new Promise(resolve=>setTimeout(resolve,1));
  assert.ok(h.fetches.length>0);
  await h.stop();await first;
  assert.equal(h.downloads.length,0);assert.equal(h.messages.some(m=>m.action==='downloadCancelled'),true);
  assert.ok(h.fetches.every(f=>f.signal.aborted));assert.equal((await h.state()).active,false);
});
test('navigation during a job cancels remaining work and never downloads a PDF',async()=>{
  const h=workerHarness({total:12,navigateOnRender:true});await h.run();
  assert.ok(h.renders.length>0);assert.equal(h.downloads.length,0);
  assert.match(h.messages.find(m=>m.action==='downloadError').error,/thay đổi|tải lại/i);
});
test('native Save is an explicit commit boundary and does not acknowledge Stop after export starts',async()=>{
  const h=workerHarness({total:2,deferSave:true}),running=h.run();await h.saving;
  let state,stopped;
  try{state=await h.state();stopped=await h.stop();h.updates.forEach(fn=>fn(8,{url:'https://www.studocu.vn/vn/document/a/b/99'}));}
  finally{h.releaseSave();await running;}
  assert.equal(state.status,'saving');assert.equal(state.cancellable,false);assert.equal(stopped.cancellable,false);
  assert.equal(h.messages.some(m=>m.action==='downloadCancelled'),false);assert.equal((await h.state()).status,'complete');
});

function directPopup({ready=true,job={active:false,downloadedCount:0},missingScript=false,holdJob=false}={}) {
  const elements=new Map(),sent=[],injected=[],listeners=[],held=[];let domReady,deferState=false;
  let releaseJob,notifyJob;const jobRequested=new Promise(resolve=>{notifyJob=resolve;});
  const state={site:'studocu',mode:'images',docId,totalPages:116,count:ready?116:0,ready,complete:false,isScanning:false,urls:[],error:ready?'':'Chưa xác định được tổng số trang.'};
  const element=id=>{
    if(!elements.has(id))elements.set(id,{style:{},disabled:false,textContent:'',innerHTML:'',scrollHeight:0,
      classList:{remove(){},add(){}},addEventListener(){},appendChild(child){this.textContent+=child.textContent;}});
    return elements.get(id);
  };
  const asTask=value=>value.active?{...value,site:'studocu',mode:'images',docId,tabId:8,taskId:value.jobId||'RUN',status:'downloading',revision:1,startedAt:1}:value;
  const runtime={lastError:null,onMessage:{addListener(fn){listeners.push(fn);},removeListener(){}},async sendMessage(message){sent.push(message);
    if(message.action==='getStudocuTask'){notifyJob();if(holdJob)return new Promise(resolve=>{releaseJob=v=>resolve(asTask(v));});return asTask(job);}
    if(message.action==='startStudocuTask')return asTask({active:true,totalPages:116,downloadedCount:0});
    if(message.action==='stopStudocuTask')return{...asTask({active:true,totalPages:116}),status:'cancelled',active:false,revision:2};
    return{};
  }};
  const scope=vm.createContext({console,URL,StudocuSupport:support,document:{getElementById:element,createElement:()=>({textContent:''}),addEventListener(name,fn){if(name==='DOMContentLoaded')domReady=fn;}},
    chrome:{runtime,tabs:{async query(){return[{id:8,windowId:1,url:`https://www.studocu.vn/vn/document/a/b/${docId}`}];},sendMessage(id,message,callback){
      if(missingScript){missingScript=false;runtime.lastError={message:'Receiving end does not exist'};callback();return;}
      if(message.action==='getScanState'&&deferState){held.push(callback);return;}
      runtime.lastError=null;callback(state);
    }},scripting:{executeScript(options,callback){injected.push(options.files);runtime.lastError=null;callback();}}}});
  vm.runInContext(fs.readFileSync('./popup.js','utf8'),scope);
  return {elements,sent,injected,start:()=>domReady(),download:()=>vm.runInContext('downloadPDF()',scope),stop:()=>vm.runInContext('stopScan()',scope),
    jobRequested,releaseJob:value=>releaseJob(value),
    holdState(){deferState=true;},releaseState(){deferState=false;held.splice(0).forEach(fn=>fn(state));},
    emit:message=>listeners.forEach(fn=>fn({site:'studocu',mode:'images',docId,tabId:8,...message},{}))};
}
test('direct popup enables download from manifest readiness without claiming the images are downloaded',async()=>{
  const h=directPopup();await h.start();
  assert.equal(h.elements.get('btn-download').disabled,false);
  assert.match(h.elements.get('log').textContent,/Sẵn sàng tải 116 ảnh/);
  assert.equal(h.elements.get('collected-pages').textContent,0);
  await h.download();await h.download();
  assert.equal(h.sent.filter(m=>m.action==='startStudocuTask').length,1);
  assert.equal(h.sent.find(m=>m.action==='startStudocuTask').preference,'auto');
  h.emit({action:'downloadProgress',current:3,total:116,percent:2});
  assert.equal(h.elements.get('collected-pages').textContent,3);
  h.emit({action:'downloadComplete',resolvedCount:116,candidateCount:116});
  assert.equal(h.elements.get('btn-download').disabled,false);
  assert.match(h.elements.get('log').textContent,/116\/116/);
});
test('reopened direct popup restores the active job, filters other tabs and sends Stop to the worker',async()=>{
  const h=directPopup({job:{active:true,downloadedCount:31,totalPages:116,jobId:'RUN'}});await h.start();
  assert.equal(h.elements.get('btn-download').disabled,true);assert.equal(h.elements.get('btn-stop').style.display,'block');
  assert.equal(h.elements.get('collected-pages').textContent,31);
  h.emit({action:'downloadProgress',tabId:9,current:90,total:116,percent:78});assert.equal(h.elements.get('collected-pages').textContent,31);
  await h.stop();assert.equal(h.sent.some(m=>m.action==='stopStudocuTask'&&m.tabId===8),true);
  h.emit({action:'downloadCancelled',jobId:'RUN'});assert.equal(h.elements.get('btn-stop').style.display,'none');
});
test('direct popup keeps unknown manifests disabled and reports errors and cancellation separately',async()=>{
  const h=directPopup({ready:false});await h.start();assert.equal(h.elements.get('btn-download').disabled,true);
  const live=directPopup();await live.start();await live.download();
  live.emit({action:'downloadError',error:'Trang 9: HTTP 404'});
  assert.equal(live.elements.get('btn-download').disabled,false);assert.match(live.elements.get('log').textContent,/Trang 9/);
});
test('Stop during popup preflight prevents the deferred download from starting',async()=>{
  const h=directPopup();await h.start();h.holdState();const running=h.download();
  await h.stop();h.releaseState();await running;
  assert.equal(h.sent.some(m=>m.action==='startStudocuTask'),false);
  assert.equal(h.elements.get('btn-download').disabled,false);
});
test('popup disables Stop while the native Save dialog owns the export',async()=>{
  const h=directPopup();await h.start();await h.download();
  h.emit({action:'downloadProgress',phase:'saving',cancellable:false,current:116,total:116,percent:100});
  assert.equal(h.elements.get('btn-stop').disabled,true);
  assert.match(h.elements.get('progress-text').textContent,/lưu PDF/i);
});
test('a delayed reopen snapshot cannot overwrite a newer completion event',async()=>{
  const h=directPopup({holdJob:true}),opening=h.start();await h.jobRequested;
  h.emit({action:'downloadComplete',jobId:'RUN',resolvedCount:116,candidateCount:116});
  h.releaseJob({active:true,downloadedCount:31,totalPages:116,jobId:'RUN'});await opening;
  assert.equal(h.elements.get('btn-download').disabled,false);
  assert.equal(h.elements.get('collected-pages').textContent,116);
});

test('actual content routes Studocu inspection to image readiness and renders native-size JPEGs without SVG or scroll',async()=>{
  const h=reader({total:2,samples:[1]}),canvases=[];let listener;
  h.chrome.runtime={onMessage:{addListener(fn){listener=fn;}}};
  h.document.createElement=name=>{
    assert.equal(name,'canvas');const canvas={width:0,height:0,getContext(){return{fillRect(){},drawImage(img){assert.equal(img.naturalWidth,1685);}};},toDataURL(type){assert.equal(this.width,1685);assert.equal(this.height,1192);return'data:image/jpeg;base64,'+jpegHeader.toString('base64');}};
    canvases.push(canvas);return canvas;
  };
  class TestImage {constructor(){this.naturalWidth=1685;this.naturalHeight=1192;}set src(value){if(value){assert.match(value,/^data:image\/png/);queueMicrotask(()=>this.onload());}}}
  const scope=vm.createContext({...h,StudocuSupport:support,console:{log(){}},Image:TestImage,URL,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync('./content.js','utf8'),scope);
  const send=request=>new Promise(resolve=>listener(request,{},resolve));
  const state=await send({action:'getScanState',mode:'images'});assert.equal(state.mode,'images');assert.equal(state.ready,true);assert.equal(state.complete,false);
  let legacyInspected=false;
  scope.StudocuSupport={...support,createController:()=>({inspect:async()=>{legacyInspected=true;return{complete:true,mode:'html'};}})};
  // A fresh content listener must preserve explicit legacy inspection as well.
  vm.runInContext(fs.readFileSync('./content.js','utf8'),vm.createContext({...h,StudocuSupport:scope.StudocuSupport,console:{log(){}},Image:TestImage,URL,setTimeout,clearTimeout}));
  const legacy=await send({action:'getScanState',mode:'html'});assert.equal(legacyInspected,true);assert.equal(legacy.complete,true);
  const m=await send({action:'getStudocuImageManifest',docId});assert.equal(m.pages.length,2);
  const rendered=await send({action:'renderStudocuImage',docId,pageNum:1,dataUrl:'data:image/png;base64,AAAA'});
  assert.equal(rendered.ok,true);assert.equal(rendered.width,1685);assert.equal(rendered.height,1192);
  assert.equal(canvases[0].width,0);assert.equal(h.scrolls.length,0);
});
