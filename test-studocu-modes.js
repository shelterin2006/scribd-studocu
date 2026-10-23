const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {test}=require('node:test');
const support=require('./studocu.js');
const asset='aea6696e5a2ca3aefe250dacadc036af',docId='152516256';
const base=`https://doc-assets.studocu.com/${asset}/html/`;
const policy=Buffer.from(JSON.stringify({Statement:[{Resource:base+'*.png',Condition:{DateLessThan:{'AWS:EpochTime':2000000000}}}]})).toString('base64').replaceAll('+','-').replaceAll('=','_').replaceAll('/','~');
const query=`?Policy=${policy}&Signature=valid~__&Key-Pair-Id=KEY`;
function modeReader({total=3,rendered=Array.from({length:total},(_,i)=>i),text={},transparent=false}={}){
  const stored={},messages=[],scrolls=[];let loaded=new Set(rendered);
  const window={location:{href:`https://www.studocu.vn/vn/document/a/b/${docId}`},setTimeout(fn){queueMicrotask(fn);},getComputedStyle(node){return{width:'595px',height:'842px',display:'block',visibility:'visible',filter:'none',opacity:'1',color:node.isText&&transparent?'rgba(0, 0, 0, 0)':'rgb(0, 0, 0)',...node.styleOverride};}};
  const nodes=Array.from({length:total},(_,i)=>{
    const img={src:base+`bg${(i+1).toString(16)}.png`+query,currentSrc:base+`bg${(i+1).toString(16)}.png`+query,complete:true,naturalWidth:1190,naturalHeight:1684,attributes:[],setAttribute(){},removeAttribute(){}};
    const t={textContent:text[i]||'',isText:true,parentElement:null};
    const html=()=>`<div class="pf"><div class="page-content"><div class="pc"><img src="${img.src.replaceAll('&','&amp;')}"><div class="t">${text[i]||''}</div></div></div></div>`;
    const pf={cloneNode(){return{outerHTML:html(),querySelectorAll:selector=>selector==='img'?[img]:[]};}},pc={};
    const node={getAttribute:name=>name==='data-page-index'?String(i):null,
      querySelector:selector=>selector==='.pf'?pf:selector==='.pc'&&loaded.has(i)?pc:null,
      querySelectorAll:selector=>selector==='img'?[img]:selector==='.t'&&loaded.has(i)?[t]:[],
      scrollIntoView(){scrolls.push(i+1);loaded.add(i);},parentElement:null};
    pc.parentElement=pf;pf.parentElement=node;t.parentElement=pc;return node;
  });
  const root={parentElement:{innerText:''},querySelectorAll:selector=>selector==='[data-page-index]'?nodes:[],querySelector:selector=>nodes.find((_,i)=>selector.includes(`"${i}"`))};
  nodes.forEach(n=>{n.parentElement=root;});
  const document={querySelector:selector=>selector==='#document-wrapper'?root:selector==='#__NEXT_DATA__'?{textContent:JSON.stringify({props:{pageProps:{document:{id:Number(docId),numberOfPages:total}}}})}:null,
    styleSheets:[{href:base+asset+'.css',cssRules:[{cssText:'.p2hv .pf{width:595px;height:842px}.p2hv .t{position:absolute}'}]}]};
  const chrome={runtime:{sendMessage(value){messages.push(value);return Promise.resolve();}},storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,structuredClone(stored[k])]));},async set(value){Object.assign(stored,structuredClone(value));}}}};
  return{document,window,chrome,stored,messages,scrolls,nodes,setLoaded(value){loaded=new Set(value);}};
}
test('Auto selects full reconstruction for visible text even when every page has a PNG',()=>{
  assert.equal(typeof support.detectDownloadMode,'function');
  const h=modeReader({text:{0:'LÝ THUYẾT Ô TÔ',1:'Chương 1. Động lực học'}}),d=support.detectDownloadMode(h.document,h.window);
  assert.equal(d.mode,'html');assert.match(d.reason,/chữ|HTML/i);
});
test('Auto selects images only after all pages are inspected and ignores genuinely invisible text',()=>{
  assert.equal(typeof support.detectDownloadMode,'function');
  for(const options of [{},{text:{0:'invisible OCR'},transparent:true}]){
    const h=modeReader(options);assert.equal(support.detectDownloadMode(h.document,h.window).mode,'images');
  }
  const h=modeReader({rendered:[0]});assert.equal(support.detectDownloadMode(h.document,h.window).mode,'html');
});
test('Auto retains visible descendant text, opaque text fill, and visible text resembling a watermark',()=>{
  for(const kind of ['descendant','fill','watermark']){
    const h=modeReader({text:{0:kind==='watermark'?'www.studocu.com':'Visible text'},transparent:kind!=='watermark'}),t=h.nodes[0].querySelectorAll('.t')[0];
    if(kind==='descendant')t.querySelectorAll=()=>[{textContent:'Visible text',styleOverride:{color:'rgb(0, 0, 0)'}}];
    if(kind==='fill')t.styleOverride={webkitTextFillColor:'rgb(0, 0, 0)'};
    assert.equal(support.detectDownloadMode(h.document,h.window).mode,'html',kind);
  }
});
test('full mode uses the declared 180 pages and scans only missing HTML before becoming ready',async()=>{
  assert.equal(typeof support.createDownloadController,'function');
  const h=modeReader({total:180,rendered:[0,1],text:{0:'LÝ THUYẾT Ô TÔ'}}),c=support.createDownloadController(h);
  const state=await c.inspect('auto');assert.equal(state.mode,'html');assert.equal(state.totalPages,180);assert.equal(state.count,2);assert.equal(state.ready,false);
  await c.start('html',()=>{});
  const ready=await c.inspect('html');assert.equal(ready.ready,true);assert.equal(ready.count,180);
  assert.equal(h.scrolls.length,178);assert.ok(h.messages.some(m=>m.action==='scanComplete'&&m.mode==='html'));
});
test('manual Images overrides detection while Auto refuses an image manifest when text is detected',async()=>{
  assert.equal(typeof support.createDownloadController,'function');
  const h=modeReader({text:{0:'BÀI GIẢNG'}}),c=support.createDownloadController(h);
  const manual=await c.inspect('images');assert.equal(manual.mode,'images');assert.equal(manual.ready,true);
  await assert.rejects(c.getImageManifest({docId,preference:'auto'}),/chữ|đầy đủ/i);
  assert.equal((await c.getImageManifest({docId,preference:'images'})).pages.length,3);
});

function fullWorker({fail=false,delayed=false,changedAsset=false}={}){
  const renders=[],downloads=[],messages=[],fetches=[];let listener,stateReads=0;
  const jpeg=Buffer.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
  const state={site:'studocu',mode:'html',docId,assetId:asset,totalPages:3,count:3,complete:true,isScanning:false};
  const scope=vm.createContext({console:{log(){}},URL,Uint8Array,Buffer,atob,btoa,StudocuSupport:support,AbortController,setTimeout,clearTimeout,
    fetch:async(url,options={})=>{fetches.push({url,signal:options.signal});if(delayed)await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,50);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{name:'AbortError'}));},{once:true});
    });return{ok:!fail,status:fail?403:200,headers:{get:()=>String(url).includes('.woff')?'font/woff':'image/png'},arrayBuffer:async()=>Uint8Array.from([1,2,3]).buffer};},
    chrome:{runtime:{lastError:null,onMessage:{addListener(fn){listener=fn;}},sendMessage(value){messages.push(value);return Promise.resolve();}},
      downloads:{async download(value){downloads.push(value);return 1;}},tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}},sendMessage(id,request,callback){
        if(request.action==='getScanState'){stateReads++;return callback({...state,assetId:changedAsset&&stateReads>1?'b'.repeat(32):asset});}
        if(request.action==='getStudocuPage'||request.action==='refreshStudocuPage')return callback({ok:true,site:'studocu',docId,assetId:asset,
          css:`.p2hv .t{color:#000}@font-face{font-family:test;src:url("https://website-assets.studocu.com/fonts/document_fonts/${asset}/f1.woff")}`,
          page:{pageNum:request.pageNum,assetId:asset,width:595,height:842,html:`<div class="pf"><img src="${base}bg${request.pageNum.toString(16)}.png${query.replaceAll('&','&amp;')}"><div class="t">LÝ THUYẾT Ô TÔ — trang ${request.pageNum}</div></div>`}});
        if(request.action==='renderJsonpPageToImage'){renders.push(request.page);return callback({ok:true,dataUrl:'data:image/jpeg;base64,'+jpeg.toString('base64')});}
        if(request.action==='invalidateStudocuPage')return callback({ok:true});
        throw Error('Unexpected action '+request.action);
      }}}});
  vm.runInContext(fs.readFileSync('./background.js','utf8'),scope);
  const send=request=>new Promise(resolve=>listener(request,{},resolve));
  return{renders,downloads,messages,fetches,run:()=>send({action:'downloadImages',site:'studocu',mode:'html',docId,tabId:8,expectedPages:3}),
    state:()=>send({action:'getStudocuDownloadState',docId,tabId:8}),stop:()=>send({action:'stopStudocuDownload',docId,tabId:8})};
}
test('full worker publishes HTML job status and renders every page with its text and embedded fonts',async()=>{
  const h=fullWorker();await h.run();
  assert.equal(h.downloads.length,1);assert.equal(h.renders.length,3);
  assert.ok(h.renders.every(p=>p.html.includes('LÝ THUYẾT Ô TÔ')&&p.fontCss.includes('data:font/woff')));
  assert.equal(h.fetches.filter(f=>f.url.endsWith('.woff')).length,1);
  assert.equal((await h.state()).mode,'html');assert.equal((await h.state()).downloadedCount,3);
  assert.ok(h.messages.some(m=>m.action==='downloadComplete'&&m.mode==='html'));
});

test('Studocu full downloads report captured HTML, CSS, assets, rendering and PDF phases',async()=>{
  const h=fullWorker();await h.run();
  const state=h.messages.filter(m=>m.action==='documentActivityUpdated').at(-1);
  assert.ok(state);
  for(const stage of ['document_check','html','assets','fonts','render','pdf','saving'])
    assert.ok(state.logs.some(l=>l.event==='stageComplete'&&l.stage===stage&&l.elapsedMs>=0),stage);
  assert.equal(state.activeStages.length,0);assert.equal(state.active,false);
  assert.equal(h.downloads.length,1);
});
test('full worker supports Stop and rejects a duplicate download across the shared tab job',async()=>{
  const h=fullWorker({delayed:true}),running=h.run();
  assert.equal((await h.run()).status,'busy');
  await new Promise(resolve=>setTimeout(resolve,2));assert.ok(h.fetches.length>0);
  assert.equal((await h.state()).active,true);await h.stop();await running;
  assert.equal(h.downloads.length,0);assert.ok(h.fetches.every(f=>f.signal.aborted));
  assert.ok(h.messages.some(m=>m.action==='downloadCancelled'));
});
test('full worker never exports after a font failure or final asset identity change',async()=>{
  for(const options of [{fail:true},{changedAsset:true}]){
    const h=fullWorker(options);await h.run();assert.equal(h.downloads.length,0);
    assert.ok(h.messages.some(m=>m.action==='downloadError'));assert.equal(h.messages.some(m=>m.action==='downloadComplete'),false);
  }
});

function modePopup({preference='auto',complete=false,autoMode='html',job={active:false}}={}){
  const elements=new Map(),sent=[],content=[],stored={[`studocuMode:${docId}`]:preference},listeners=[],held=[];let readyHandler,holdState=false;
  const full={site:'studocu',mode:'html',docId,totalPages:180,count:complete?180:17,complete,ready:complete,isScanning:false,urls:[],detection:{mode:autoMode,reason:'Có chữ nằm riêng trong HTML.'}};
  const image={...full,mode:'images',ready:true,complete:false,count:180};
  const el=id=>{if(!elements.has(id))elements.set(id,{style:{},value:'',disabled:false,textContent:'',innerHTML:'',scrollHeight:0,events:{},classList:{remove(){},add(){}},addEventListener(name,fn){this.events[name]=fn;},appendChild(child){this.textContent+=child.textContent;}});return elements.get(id);};
  let task=job.active?{...job,site:'studocu',docId,tabId:8,taskId:job.jobId||'HTML',status:'downloading',revision:1,startedAt:1}:job;
  const runtime={lastError:null,onMessage:{addListener(fn){listeners.push(fn);},removeListener(){}},async sendMessage(request){sent.push(request);
    if(request.action==='getStudocuTask')return task;
    if(request.action==='startStudocuTask')return task={site:'studocu',docId,tabId:8,taskId:'HTML',mode:request.preference==='auto'?autoMode:request.preference,totalPages:180,count:full.count,downloadedCount:0,active:true,status:full.complete?'downloading':'scanning',revision:1,startedAt:1};
    if(request.action==='stopStudocuTask')return task={...task,status:'cancelled',active:false,revision:(task.revision||0)+1};
    return{};
  }};
  const scope=vm.createContext({console,URL,StudocuSupport:support,document:{getElementById:el,createElement:()=>({textContent:''}),addEventListener(name,fn){if(name==='DOMContentLoaded')readyHandler=fn;}},chrome:{runtime,
    storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,stored[k]]));},async set(value){Object.assign(stored,value);}}},
    tabs:{async query(){return[{id:8,windowId:1,url:`https://www.studocu.vn/vn/document/a/b/${docId}`}];},sendMessage(id,request,callback){content.push(request);const selected=request.preference==='images'||(request.preference==='auto'&&autoMode==='images')?image:full;
      if(request.action==='startScan'){full.isScanning=true;return callback({status:'started',mode:'html',totalPages:180});}
      if(request.action==='stopScan'){full.isScanning=false;return callback({status:'stopped'});}
      if(request.action==='getScanState'&&holdState){held.push({callback,state:{...selected}});return;}
      callback({...selected});
    }}}});
  vm.runInContext(fs.readFileSync('./popup.js','utf8'),scope);
  return{elements,sent,content,stored,start:()=>readyHandler(),download:()=>vm.runInContext('downloadPDF()',scope),scan:()=>vm.runInContext('startScan()',scope),stop:()=>vm.runInContext('stopScan()',scope),
    refresh:()=>vm.runInContext('restoreScanState()',scope),holdState(){holdState=true;},releaseState(){holdState=false;held.splice(0).forEach(item=>item.callback(item.state));},
    async select(value){el('studocu-mode').value=value;await el('studocu-mode').events.change();},
    emit(message){if(message.action==='scanComplete'){full.complete=message.complete;full.ready=message.complete;full.count=message.count;full.isScanning=false;}listeners.forEach(fn=>fn({site:'studocu',mode:'html',docId,tabId:8,...message},{}));}};
}
test('popup defaults to Auto, explains full selection and scans missing pages before the full download',async()=>{
  const h=modePopup();await h.start();
  assert.equal(h.elements.get('studocu-mode').value,'auto');assert.match(h.elements.get('mode-description').textContent,/đầy đủ|chữ/i);
  assert.equal(h.elements.get('collected-pages').textContent,17);assert.equal(h.elements.get('btn-download').disabled,true);
  await h.scan();assert.equal(h.sent.find(m=>m.action==='startStudocuTask').preference,'auto');assert.equal(h.elements.get('studocu-mode').disabled,true);
  h.emit({action:'scanComplete',count:180,totalPages:180,complete:true,urls:[]});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.sent.some(m=>m.action==='downloadImages'),false);
  assert.equal(h.sent.filter(m=>m.action==='startStudocuTask').length,1);
});
test('popup restores and persists per-document overrides and downloads through the selected method',async()=>{
  const h=modePopup({complete:true});await h.start();await h.select('images');
  assert.equal(h.stored[`studocuMode:${docId}`],'images');assert.match(h.elements.get('btn-download').textContent,/ảnh/i);
  await h.download();assert.equal(h.sent.find(m=>m.action==='startStudocuTask').preference,'images');
  const restored=modePopup({preference:'html',complete:true});await restored.start();
  assert.equal(restored.elements.get('studocu-mode').value,'html');await restored.download();
  assert.equal(restored.sent.find(m=>m.action==='startStudocuTask').preference,'html');
});
test('full popup restores active reconstruction and Stop targets the worker; stopped scans do not auto-download',async()=>{
  const h=modePopup({complete:true,job:{active:true,mode:'html',jobId:'HTML',downloadedCount:29,totalPages:180,cancellable:true}});await h.start();
  assert.equal(h.elements.get('btn-download').disabled,true);assert.equal(h.elements.get('collected-pages').textContent,29);
  await h.stop();assert.ok(h.sent.some(m=>m.action==='stopStudocuTask'));
  const scan=modePopup();await scan.start();await scan.scan();await scan.stop();
  scan.emit({action:'scanComplete',count:180,totalPages:180,complete:true,urls:[]});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(scan.sent.some(m=>m.action==='downloadImages'),false);
  scan.emit({action:'scanProgress',count:18,totalPages:180,complete:false,isScanning:true});
  assert.equal(scan.elements.get('btn-stop').style.display,'none');
});
test('stale inspections cannot unlock controls after a scan starts and reports progress',async()=>{
  const h=modePopup();await h.start();h.holdState();const stale=h.refresh();
  const starting=h.scan();h.emit({action:'studocuTaskUpdated',taskId:'HTML',revision:1,startedAt:1,status:'scanning',active:true,count:18,totalPages:180,complete:false,isScanning:true});
  h.releaseState();await stale;await starting;
  assert.equal(h.elements.get('btn-stop').style.display,'block');assert.equal(h.elements.get('studocu-mode').disabled,true);
});

test('full popup discloses font fallback when a PDF completes',async()=>{
  const h=modePopup({complete:true});await h.start();
  h.emit({action:'downloadComplete',totalPages:180,resolvedCount:180,fontFallbackCount:5});
  assert.match(h.elements.get('log').textContent,/5 font.*dự phòng/i);
});
