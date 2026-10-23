const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {test}=require('node:test');
const support=require('./studocu.js');
const asset='09bb027d5054f5e232227e5bed57b253',docId='56109361';
const taskSupport=fs.existsSync('./studocu-tasks.js')?require('./studocu-tasks.js'):{};

function scanReader({hidden=false,onTick=()=>{},onMessage=()=>{}}={}){
  let clock=0,ticks=0,loaded=false;const messages=[],scrolls=[],events=new Map();
  const document={hidden,addEventListener(name,fn){events.set(name,fn);},removeEventListener(name){events.delete(name);}};
  const window={location:{href:`https://www.studocu.vn/vn/document/a/b/${docId}`},performance:{now:()=>clock},
    setTimeout(fn,ms){queueMicrotask(()=>{clock+=ms;onTick(++ticks,h);fn();});return ticks+1;},clearTimeout(){},
    getComputedStyle(){return{width:'595px',height:'842px',filter:'none',visibility:'visible',display:'block'};}};
  const nodes=[0,1].map(i=>{
    const img={src:`https://doc-assets.studocu.com/${asset}/html/bg${i+1}.png`,complete:true,naturalWidth:1190,attributes:[],setAttribute(){}};
    const pf={cloneNode(){return{outerHTML:`<div class="pf"><img src="${img.src}"><div class="t">Page ${i+1}</div></div>`,querySelectorAll:s=>s==='img'?[img]:[]};}};
    return{getAttribute:()=>String(i),querySelector:s=>i===0||loaded?s==='.pf'?pf:s==='.pc'?{}:null:null,
      querySelectorAll:s=>i===0||loaded?s==='img'?[img]:s==='.t'?[{textContent:'Page'}]:[]:[],scrollIntoView(){scrolls.push(i+1);}};
  });
  const root={parentElement:{innerText:''},querySelectorAll:()=>nodes,querySelector:s=>nodes.find((n,i)=>s.includes(`"${i}"`))};
  document.querySelector=s=>s==='#document-wrapper'?root:s==='#__NEXT_DATA__'?{textContent:JSON.stringify({props:{pageProps:{document:{id:docId,numberOfPages:2}}}})}:null;
  document.styleSheets=[{href:`https://doc-assets.studocu.com/${asset}/html/${asset}.css`,cssRules:[{cssText:'.pf{width:595px}'}]}];
  const stored={};const chrome={runtime:{sendMessage(m){messages.push(m);onMessage(m,h);return Promise.resolve();}},storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,stored[k]]));},async set(v){Object.assign(stored,v);}}}};
  const h={document,window,chrome,messages,scrolls,stored,load(){loaded=true;},advance(ms){clock+=ms;},hide(){document.hidden=true;events.get('visibilitychange')?.();},visible(){document.hidden=false;events.get('visibilitychange')?.();},get ticks(){return ticks;}};
  return h;
}

test('scanner keeps waiting for HTML arriving after the old third check and includes task identity',async()=>{
  const h=scanReader({onTick(n,h){if(n===5)h.load();}}),c=support.createController(h);
  await c.start(()=>{},{taskId:'T1'});const state=await c.inspect();
  assert.equal(state.complete,true);assert.equal(state.taskId,'T1');assert.equal(h.ticks,5);
  assert.equal(h.messages.at(-1).scanStatus,'complete');
});

test('scanner exhausts two visible 15-second passes and explicitly reports incomplete pages',async()=>{
  const h=scanReader(),c=support.createController(h);await c.start(()=>{},{taskId:'T2'});
  const state=await c.inspect();assert.equal(h.ticks,30);assert.deepEqual(h.scrolls,[2,2]);
  assert.equal(state.isScanning,false);assert.equal(state.scanStatus,'incomplete');assert.deepEqual(state.missingPages,[2]);
});

test('hidden scanner waits for foreground without consuming a pass and resumes on visibility',async()=>{
  const h=scanReader({hidden:true,onMessage(m,h){if(m.scanStatus==='waiting_foreground'){h.visible();h.load();}}}),c=support.createController(h);
  await c.start(()=>{},{taskId:'T3'});
  assert.ok(h.messages.some(m=>m.scanStatus==='waiting_foreground'&&m.taskId==='T3'&&m.isScanning));
  assert.equal((await c.inspect()).complete,true);assert.deepEqual(h.scrolls,[2]);
});

test('Stop while waiting for foreground terminates the scanner and suppresses scanComplete',async()=>{
  let c;const h=scanReader({hidden:true,onMessage(m){if(m.scanStatus==='waiting_foreground')c.stop();}});c=support.createController(h);
  await c.start(()=>{},{taskId:'T4'});h.visible();h.load();await Promise.resolve();
  assert.equal((await c.inspect()).isScanning,false);assert.equal(h.messages.some(m=>m.action==='scanComplete'),false);
});

test('a task stopped before its delayed start message cannot start scrolling later',async()=>{
  const h=scanReader(),c=support.createController(h);c.stop('DELAYED');
  await c.start(()=>{},{taskId:'DELAYED'});
  assert.deepEqual(h.scrolls,[]);assert.equal((await c.inspect()).isScanning,false);
});

test('a stale Stop cannot cancel a newer scanner task',async()=>{
  let c;const h=scanReader({hidden:true,onMessage(m,h){if(m.scanStatus==='waiting_foreground'){c.stop('OLD');h.visible();h.load();}}});c=support.createController(h);
  await c.start(()=>{},{taskId:'NEW'});assert.equal((await c.inspect()).complete,true);
});

test('DOM mutation wakes the scanner immediately and cleans up its observer',async()=>{
  let callback,disconnected=0,timers=0;
  const h=scanReader();h.window.MutationObserver=class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnected++;}};
  h.window.clearTimeout=clearTimeout;
  h.window.setTimeout=fn=>{const timer=setTimeout(()=>{timers++;fn();},10000);queueMicrotask(()=>{h.load();callback();});return timer;};
  const c=support.createController(h);await c.start(()=>{},{taskId:'DOM'});
  assert.equal((await c.inspect()).complete,true);assert.equal(timers,0);assert.equal(disconnected,1);
});

test('visibility changes during async storage never count hidden time toward the visible budget',async()=>{
  const h=scanReader();let writes=0;const save=h.chrome.storage.local.set;
  h.chrome.storage.local.set=async value=>{if(++writes===2){h.hide();h.advance(20000);h.visible();}await save(value);};
  const c=support.createController(h);await c.start(()=>{},{taskId:'VISIBILITY'});
  assert.equal(h.ticks,30);assert.equal((await c.inspect()).scanStatus,'incomplete');
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function taskHarness({stored={},state:initial,delayed=false,failStorage=false}={}){
  const messages=[],commands=[],downloads=[],aborts=[],writes=[];
  let state=initial||{site:'studocu',mode:'html',docId,assetId:asset,totalPages:2,count:1,complete:false,ready:false,isScanning:false,missingPages:[2]};
  let worker={active:false},finishDownload;
  const chrome={runtime:{async sendMessage(m){messages.push(m);}},storage:{local:{async get(keys){return keys===null?structuredClone(stored):Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,structuredClone(stored[k])]));},async set(value){if(failStorage)throw Error('quota');writes.push(structuredClone(value));Object.assign(stored,structuredClone(value));}}}};
  assert.equal(typeof taskSupport.create,'function');
  const options={chrome,support,sendContent:async(tabId,request)=>{
    commands.push(request);
    if(request.action==='getScanState')return{...state};
    if(request.action==='startScan'){state={...state,taskId:request.taskId,isScanning:true};return{status:'started',taskId:request.taskId};}
    if(request.action==='stopScan'){if(state.taskId===request.taskId)state={...state,isScanning:false,scanStatus:'cancelled'};return{status:'stopped'};}
    throw Error('Unexpected '+request.action);
  },downloadState:()=>worker,stopDownload(tabId,id){aborts.push(id);worker={...worker,active:false};finishDownload?.({status:'cancelled'});},
  async startDownload(request){downloads.push(request);worker={active:true,cancellable:true,taskId:request.taskId};if(delayed)return new Promise(resolve=>{finishDownload=resolve;});worker={active:false,status:'complete',fontFallbackCount:0};return{status:'finished'};}};
  const manager=taskSupport.create(options);
  const h={manager,options,stored,messages,commands,downloads,aborts,writes,get state(){return state;},setState(value){state={...state,...value};},
    async start(){const result=await manager.start({tabId:8,docId,preference:'auto'});await settle();return result;},
    async emit(action='scanComplete',overrides={},sender={tab:{id:8}}){return manager.onScanner({action,site:'studocu',mode:'html',...state,...overrides},sender);},
    async complete(){state={...state,count:2,ready:true,complete:true,isScanning:false,scanStatus:'complete',missingPages:[]};await h.emit();await settle();},
    setSaving(){worker={...worker,active:true,cancellable:false,status:'saving'};}};
  return h;
}

test('background persists ownership before scanning and automatically downloads once without any popup',async()=>{
  const h=taskHarness();await h.start();let task=await h.manager.get(8,docId);
  assert.equal(task.status,'scanning');assert.ok(task.taskId);assert.equal(h.writes[0]['studocuTask:8'].status,'starting');
  assert.equal(h.commands.find(c=>c.action==='startScan').taskId,task.taskId);
  await h.complete();await h.emit();await settle();
  task=await h.manager.get(8,docId);assert.equal(h.downloads.length,1);assert.equal(task.status,'complete');
  assert.equal(h.downloads[0].taskId,task.taskId);assert.ok(h.messages.some(m=>m.action==='studocuTaskUpdated'&&m.status==='complete'&&m.updatedAt));
});

test('cache reset rejects active Studocu tasks and does not erase their saved progress',async()=>{
  const h=taskHarness();await h.start();let erases=0;
  await assert.rejects(h.manager.clearDocument(docId,async()=>{erases++;}),/đang quét|đang tải/i);
  assert.equal(erases,0);assert.equal((await h.manager.get(8,docId)).status,'scanning');
});
test('cache reset forgets a completed task and ignores its late scanner events',async()=>{
  const h=taskHarness();await h.start();await h.complete();const old=await h.manager.get(8,docId);
  await h.manager.clearDocument(docId,async()=>{delete h.stored['studocuTask:8'];});
  assert.equal((await h.manager.get(8,docId)).active,false);
  await h.emit('scanComplete',{taskId:old.taskId});assert.equal(h.downloads.length,1);
});
test('a new Studocu task cannot start while its cache is being erased',async()=>{
  const h=taskHarness();await h.manager.ready;let release,entered;
  const inside=new Promise(resolve=>{entered=resolve;});
  const resetting=h.manager.clearDocument(docId,()=>{entered();return new Promise(resolve=>{release=resolve;});});
  await inside;
  await assert.rejects(h.manager.start({tabId:8,docId,preference:'html'}),/xóa cache/);
  release();await resetting;assert.equal(h.downloads.length,0);
});

test('background refuses another mode while a task runs and Stop rejects late completion',async()=>{
  const h=taskHarness();await h.start();const task=await h.manager.get(8,docId);
  assert.equal((await h.manager.start({tabId:8,docId,preference:'images'})).status,'busy');
  await h.manager.stop(8,docId,task.taskId);await h.complete();
  assert.equal(h.downloads.length,0);assert.equal((await h.manager.get(8,docId)).status,'cancelled');
});

test('background verifies sender, document, task and asset before accepting scan events',async()=>{
  const h=taskHarness();await h.start();h.setState({count:2,complete:true,ready:true,isScanning:false});
  for(const [override,sender] of [[{taskId:'old'},{tab:{id:8}}],[{assetId:'a'.repeat(32)},{tab:{id:8}}],[{docId:'99'},{tab:{id:8}}],[{},{tab:{id:9}}],[{},{}]])await h.emit('scanComplete',override,sender);
  await settle();assert.equal(h.downloads.length,0);await h.complete();assert.equal(h.downloads.length,1);
});

test('background restores a matching waiting scanner after worker restart without starting another scan',async()=>{
  const h=taskHarness();await h.start();h.setState({scanStatus:'waiting_foreground',isScanning:true});await h.emit('scanProgress');
  const resumed=taskSupport.create(h.options);await resumed.ready;
  assert.equal((await resumed.get(8,docId)).status,'waiting_foreground');assert.equal(h.commands.filter(m=>m.action==='startScan').length,1);
  h.setState({count:2,complete:true,ready:true,isScanning:false,scanStatus:'complete'});await resumed.onScanner({action:'scanComplete',site:'studocu',mode:'html',...h.state},{tab:{id:8}});await settle();
  assert.equal(h.downloads.length,1);
});

test('lost download memory after restart is interrupted and never exported automatically again',async()=>{
  const h=taskHarness({delayed:true});await h.start();await h.complete();assert.equal(h.downloads.length,1);
  const resumed=taskSupport.create({...h.options,downloadState:()=>({active:false})});await resumed.ready;
  assert.equal((await resumed.get(8,docId)).status,'interrupted');assert.equal(h.downloads.length,1);
});

test('incomplete scans never export; Stop aborts downloads but respects the native Save boundary',async()=>{
  const h=taskHarness();await h.start();h.setState({isScanning:false,scanStatus:'incomplete'});await h.emit();
  assert.equal((await h.manager.get(8,docId)).status,'incomplete');assert.equal(h.downloads.length,0);
  const d=taskHarness({delayed:true});await d.start();await d.complete();const task=await d.manager.get(8,docId);
  d.setSaving();assert.equal((await d.manager.stop(8,docId,task.taskId)).cancellable,false);assert.equal(d.aborts.length,0);
});

test('task storage failure never starts a scan or download',async()=>{
  const h=taskHarness({failStorage:true});await assert.rejects(h.start(),/quota/);assert.equal(h.commands.length,0);assert.equal(h.downloads.length,0);
});

test('Stop during background inspection prevents a deferred scan or download from starting',async()=>{
  const h=taskHarness();let release;
  const manager=taskSupport.create({...h.options,sendContent:(tabId,m)=>m.action==='getScanState'?new Promise(resolve=>{release=resolve;}):h.options.sendContent(tabId,m)});
  await manager.start({tabId:8,docId,preference:'auto'});await settle();const task=await manager.get(8,docId);
  await manager.stop(8,docId,task.taskId);release({...h.state});await settle();
  assert.equal(h.commands.some(m=>m.action==='startScan'),false);assert.equal(h.downloads.length,0);
});

test('worker recovery advances matching completed scanner exactly once',async()=>{
  const h=taskHarness();await h.start();h.setState({count:2,complete:true,ready:true,isScanning:false,scanStatus:'complete'});
  const resumed=taskSupport.create(h.options);await resumed.ready;await settle();
  assert.equal(h.downloads.length,1);assert.equal((await resumed.get(8,docId)).status,'complete');
});

test('a retained inactive download never disables Stop for the next scanning task',async()=>{
  const h=taskHarness();const manager=taskSupport.create({...h.options,downloadState:()=>({active:false,cancellable:false,taskId:'OLD'})});
  await manager.start({tabId:8,docId,preference:'auto'});await settle();const task=await manager.get(8,docId);
  assert.equal(task.cancellable,true);await manager.stop(8,docId,task.taskId);
  assert.equal((await manager.get(8,docId)).status,'cancelled');assert.ok(h.commands.some(m=>m.action==='stopScan'));
});

test('Stop still stops content when cancellation persistence fails and recovery cannot export its completed cache',async()=>{
  const h=taskHarness();await h.start();const task=await h.manager.get(8,docId),save=h.options.chrome.storage.local.set;
  h.options.chrome.storage.local.set=async()=>{throw Error('quota');};
  await h.manager.stop(8,docId,task.taskId).catch(()=>{});
  assert.ok(h.commands.some(m=>m.action==='stopScan'));assert.equal(h.state.scanStatus,'cancelled');
  h.options.chrome.storage.local.set=save;h.setState({complete:true,ready:true,count:2,isScanning:false});
  const resumed=taskSupport.create(h.options);await resumed.ready;await settle();
  assert.equal(h.downloads.length,0);assert.equal((await resumed.get(8,docId)).status,'cancelled');
});

function wiredBackground(){
  let listener,updated;const stored={},downloads=[],messages=[],commands=[];
  let state={site:'studocu',mode:'html',docId,assetId:asset,totalPages:2,count:1,complete:false,ready:false,isScanning:false,missingPages:[2]};
  const jpeg=Buffer.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
  const scope=vm.createContext({console,URL,Uint8Array,Buffer,atob,btoa,AbortController,setTimeout,clearTimeout,StudocuSupport:support,StudocuTasks:taskSupport,
    chrome:{storage:{local:{async get(keys){return keys===null?structuredClone(stored):Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,stored[k]]));},async set(v){Object.assign(stored,structuredClone(v));}}},
      runtime:{lastError:null,onMessage:{addListener(fn){listener=fn;}},async sendMessage(m){messages.push(m);}},
      downloads:{async download(value){downloads.push(value);return 1;}},tabs:{onUpdated:{addListener(fn){updated=fn;}},onRemoved:{addListener(){}},sendMessage(id,request,cb){commands.push(request);
        if(request.action==='getScanState')return cb({...state});
        if(request.action==='startScan'){state={...state,taskId:request.taskId,isScanning:true};return cb({status:'started',taskId:request.taskId});}
        if(request.action==='stopScan')return cb({status:'stopped'});
        if(request.action==='getStudocuPage')return cb({ok:true,docId,assetId:asset,css:'.t{color:black}',page:{pageNum:request.pageNum,assetId:asset,width:595,height:842,html:'<div class="t">Word Form</div>'}});
        if(request.action==='renderJsonpPageToImage')return cb({ok:true,dataUrl:'data:image/jpeg;base64,'+jpeg.toString('base64')});
        throw Error('Unexpected '+request.action);
      }}}});
  vm.runInContext(fs.readFileSync('./background.js','utf8'),scope);
  const send=(request,sender={})=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No reply: '+request.action)),100);const done=value=>{clearTimeout(timer);resolve(value);};if(listener(request,sender,done)===false)done(undefined);});
  return{stored,downloads,messages,commands,send,change(){updated(8,{url:'https://www.studocu.vn/vn/document/a/b/99'});},
    async start(){await send({action:'startStudocuTask',tabId:8,docId,preference:'auto'});await settle();},
    async complete(){state={...state,count:2,ready:true,complete:true,isScanning:false,scanStatus:'complete',missingPages:[]};await send({action:'scanComplete',...state},{tab:{id:8}});await settle();}};
}

test('actual background listener owns scan-to-PDF handoff and rejects a legacy duplicate',async()=>{
  const h=wiredBackground();await h.start();
  assert.ok(h.stored['studocuTask:8']?.taskId);
  const duplicate=await h.send({action:'downloadImages',site:'studocu',mode:'images',tabId:8,docId,expectedPages:2});assert.equal(duplicate.status,'busy');
  await h.complete();assert.equal(h.downloads.length,1);
  assert.match(Buffer.from(h.downloads[0].url.split(',')[1],'base64').toString('latin1'),/\/Count 2\b/);
  assert.equal((await h.send({action:'getStudocuTask',tabId:8,docId})).status,'complete');
});

test('actual tab navigation cancels a scanning task and late completion cannot export',async()=>{
  const h=wiredBackground();await h.start();h.change();await settle();await h.complete();
  assert.equal(h.downloads.length,0);assert.equal((await h.send({action:'getStudocuTask',tabId:8,docId})).status,'cancelled');
});

function taskPopup(initial={}){
  const elements=new Map(),sent=[],listeners=[];let domReady;
  let task=initial;
  const state={site:'studocu',mode:'html',docId,assetId:asset,totalPages:2,count:1,complete:false,ready:false,isScanning:false,missingPages:[2]};
  const element=id=>{if(!elements.has(id))elements.set(id,{style:{},value:'auto',disabled:false,textContent:'',innerHTML:'',scrollHeight:0,classList:{add(){},remove(){}},addEventListener(){},appendChild(n){this.textContent+=n.textContent;}});return elements.get(id);};
  const scope=vm.createContext({console,URL,StudocuSupport:support,document:{getElementById:element,createElement:()=>({textContent:''}),addEventListener(n,fn){if(n==='DOMContentLoaded')domReady=fn;}},
    chrome:{runtime:{onMessage:{addListener(fn){listeners.push(fn);}},async sendMessage(m){sent.push(m);
      if(m.action==='getStudocuTask')return task;
      if(m.action==='startStudocuTask')return task={...state,taskId:'TASK',revision:1,status:'starting',active:true,tabId:8,startedAt:100,updatedAt:100};
      if(m.action==='stopStudocuTask')return task={...task,revision:task.revision+1,status:'cancelled',active:false};
      return{};
    }},storage:{local:{async get(){return{};},async set(){}}},tabs:{async query(){return[{id:8,url:`https://www.studocu.vn/vn/document/a/b/${docId}`}];},sendMessage(id,m,cb){cb({...state});}}}});
  vm.runInContext(fs.readFileSync('./popup.js','utf8'),scope);
  return{elements,sent,start:()=>domReady(),scan:()=>vm.runInContext('startScan()',scope),stop:()=>vm.runInContext('stopScan()',scope),
    emit(change){task={...task,...change};listeners.forEach(fn=>fn({action:'studocuTaskUpdated',...state,taskId:'TASK',tabId:8,startedAt:100,updatedAt:101,...task},{}));},
    rawScan(){listeners.forEach(fn=>fn({action:'scanComplete',...state,count:2,complete:true},{}));}};
}

test('popup starts one background task and never owns the scan-to-download handoff',async()=>{
  const h=taskPopup();await h.start();await h.scan();
  assert.equal(h.sent.filter(m=>m.action==='startStudocuTask').length,1);
  h.rawScan();await settle();assert.equal(h.sent.some(m=>m.action==='downloadImages'),false);
});

test('popup restores waiting-foreground state, Stop and revision guards reject stale updates',async()=>{
  const initial={site:'studocu',docId,tabId:8,taskId:'TASK',mode:'html',status:'waiting_foreground',active:true,totalPages:2,count:1,revision:3,startedAt:100};
  const h=taskPopup(initial);await h.start();assert.match(h.elements.get('progress-text').textContent,/quay lại tab/i);
  assert.equal(h.elements.get('studocu-mode').disabled,true);await h.stop();
  assert.equal(h.sent.some(m=>m.action==='stopStudocuTask'&&m.taskId==='TASK'),true);
  h.emit({...initial,revision:2,status:'scanning'});
  assert.equal(h.elements.get('btn-stop').style.display,'none');
});

test('reopened popup shows completed background task without starting another download',async()=>{
  const h=taskPopup({site:'studocu',docId,tabId:8,taskId:'TASK',mode:'html',status:'complete',active:false,totalPages:2,count:2,downloadedCount:2,revision:10,startedAt:100});await h.start();
  assert.match(h.elements.get('progress-text').textContent,/2\/2/);assert.equal(h.elements.get('btn-download').disabled,false);
  assert.equal(h.sent.some(m=>m.action==='startStudocuTask'||m.action==='downloadImages'),false);
});

test('new popup preflight resets cancellation availability from the previous completed task',async()=>{
  const h=taskPopup({site:'studocu',docId,tabId:8,taskId:'OLD',mode:'html',status:'complete',active:false,cancellable:false,totalPages:2,count:2,downloadedCount:2,revision:10,startedAt:1});await h.start();
  const starting=h.scan();assert.equal(h.elements.get('btn-stop').disabled,false);await starting;
});
