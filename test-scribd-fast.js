const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const jpeg = Buffer.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
const base = 'https://html.scribdassets.com/current';
const url = n => `${base}/pages/${n}-hash${n}.jsonp`;
const imageUrl = n => `${base}/images/${n}-hash${n}.jpg`;
function html(n, extra='') {
  return `<div class="newpage" id="page${n}" style="width:902px;height:1167px"><div class=image_layer style="z-index:1"><div class=ie_fix><img class="absimg" style="left:17px;top:10px;width:856px;height:1135px;clip:rect(1px 855px 1134px 1px)" orig="${imageUrl(n)}"/></div></div>${extra}</div>`;
}
function harness({total=6, pageHtml=html, status=()=>200, navigate=false, imageBytes=jpeg, contextCss='', onTab, timers, clock}={}) {
  const fetched=[], renders=[], downloads=[], messages=[], actions=[];
  let active=0, maxActive=0, listener, finish, info=0;
  const done = new Promise(resolve=>{finish=resolve;});
  const context=vm.createContext({URL, Uint8Array, Buffer, atob, btoa, AbortController, Date:clock||Date,
    setTimeout:timers?.setTimeout||setTimeout, clearTimeout:timers?.clearTimeout||clearTimeout, console:{log(){}},
    fetch:async (source,options={})=>{
      const n=Number(source.match(/\/(?:pages|images)\/(\d+)-/)?.[1]||0);
      const attempt=fetched.filter(x=>x.url===source).length+1;fetched.push({url:source,signal:options.signal});
      active++;maxActive=Math.max(active,maxActive);
      try {
        await new Promise(resolve=>setTimeout(resolve,(total-n)%4+2));
        const code=status(source,attempt);
        if(code==='network')throw Error('network down');
        return {ok:code===200,status:code,headers:{get:()=>source.includes('.woff2')?'font/woff2':'image/jpeg'},
          text:async()=>`window.page${n}_callback(${JSON.stringify([pageHtml(n)])});`,
          arrayBuffer:async()=>imageBytes.buffer.slice(imageBytes.byteOffset,imageBytes.byteOffset+imageBytes.length)};
      } finally {active--;}
    },
    chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}},sendMessage(m){messages.push(m);if(['downloadComplete','downloadError'].includes(m.action))finish(m);return Promise.resolve();}},
      tabs:{sendMessage(tabId,m,callback){actions.push(m);if(onTab?.(m,callback))return;if(m.action==='getDocInfo')callback({docId:navigate&&++info>1?'999':'123',totalPages:total});
        else if(m.action==='getScribdRendererContext')callback({ok:true,html:m.page.html,css:contextCss});
        else if(['renderJsonpPageToImage','renderScribdImage'].includes(m.action)){renders.push(m);callback({ok:true,fontFallbacks:(m.page?.missingFonts||[]).map(family=>({family})),dataUrl:'data:image/jpeg;base64,'+jpeg.toString('base64')});}
        else if(m.action==='refreshScanPage')callback({ok:false});else throw Error('Unexpected action '+m.action);}},
      downloads:{async download(value){downloads.push(value);return 1;}}}});
  vm.runInContext(fs.readFileSync('background.js','utf8'),context);
  return {context, fetched,renders,downloads,messages,actions,done,get maxActive(){return maxActive;},
    start(extra={}){listener({action:'downloadImages',docId:'123',tabId:7,expectedPages:total,fast:true,urls:Array.from({length:total},(_,i)=>url(total-i)),...extra},{},()=>{});},
    pdf(){return Buffer.from(downloads[0].url.split(',')[1],'base64').toString('latin1');}};
}

test('fast Scribd embeds original JPEGs without the HTML renderer and preserves page margins and clipping',async()=>{
  const h=harness();h.start();assert.equal((await h.done).action,'downloadComplete');
  assert.equal(h.renders.length,0);assert.equal(h.downloads.length,1);
  assert.match(h.pdf(),/\/MediaBox \[0 0 902 1167\]/);
  assert.match(h.pdf(),/18 23 854 1133 re W n/);
  assert.match(h.pdf(),/856 0 0 1135 17 22 cm/);
  assert.match(h.pdf(),/\/Width 600 \/Height 800/);
  assert.match(h.pdf(),/\/Count 6\b/);
});
test('fast Scribd overlaps up to four page downloads, retains page order and reports monotonic progress',async()=>{
  const h=harness({total:9,pageHtml:n=>html(n).replace('left:17px',`left:${100+n}px`)});h.start();await h.done;
  assert.equal(h.maxActive,4);
  assert.equal(h.fetched.length,18);
  assert.deepEqual(h.messages.filter(m=>m.action==='downloadProgress').map(m=>m.current),[1,2,3,4,5,6,7,8,9]);
  const positions=[...h.pdf().matchAll(/856 0 0 1135 (\d+) 22 cm/g)].map(m=>Number(m[1]));
  assert.deepEqual(positions,[101,102,103,104,105,106,107,108,109]);
});
test('mixed Scribd pages retain HTML text and embedded fonts while image-only pages bypass rendering',async()=>{
  const h=harness({total:2,pageHtml:n=>n===2?html(n,'<div class=text_layer><span class="ff4" style="left:50px">KEEP THIS TEXT</span></div>'):html(n)});
  h.start();assert.equal((await h.done).action,'downloadComplete');
  assert.equal(h.renders.length,1);assert.equal(h.renders[0].page.pageNum,2);
  assert.match(h.renders[0].page.html,/KEEP THIS TEXT/);assert.match(h.renders[0].page.html,/src="data:image\/jpeg;base64,/);
  assert.match(h.renders[0].page.fontCss,/@font-face/);
});
test('two image elements sharing one JPEG retain both placements without downloading the JPEG twice',async()=>{
  const second=`<img class="absimg" style="left:893px;top:-642px;width:856px;height:1135px;clip:rect(1132px 6px 1135px 1px)" orig="${imageUrl(1)}"/>`;
  const h=harness({total:1,pageHtml:n=>html(n).replace('</div></div></div>',second+'</div></div></div>')});
  h.start();await h.done;assert.equal(h.renders.length,0);
  assert.equal(h.fetched.filter(f=>f.url===imageUrl(1)).length,1);
  assert.equal((h.pdf().match(/\/Im1 Do/g)||[]).length,2);
});
test('unsupported image styling falls back to the complete renderer instead of silently flattening it',async()=>{
  const h=harness({total:1,pageHtml:n=>html(n).replace('left:17px','transform:rotate(15deg);left:17px')});
  h.start();await h.done;assert.equal(h.renders.length,1);assert.match(h.renders[0].page.html,/rotate\(15deg\)/);
});
test('a failed image prevents any partial PDF and identifies the failed page',async()=>{
  const h=harness({total:3,status:u=>u===imageUrl(2)?404:200});h.start();const result=await h.done;
  assert.equal(result.action,'downloadError');assert.match(result.error,/2/);assert.equal(h.downloads.length,0);
});
test('fast loading retries transient errors once without issuing HEAD requests',async()=>{
  const h=harness({total:2,status:(u,n)=>n===1?(u.includes('/pages/')?'network':503):200});
  h.start();assert.equal((await h.done).action,'downloadComplete');
  for(const u of [url(1),url(2),imageUrl(1),imageUrl(2)])assert.equal(h.fetched.filter(x=>x.url===u).length,2);
});
test('changing source document before PDF export never saves the old document under the new tab',async()=>{
  const h=harness({total:2,navigate:true});h.start();assert.equal((await h.done).action,'downloadError');assert.equal(h.downloads.length,0);
});
test('an access failure refreshes only the failed page without scrolling',async()=>{
  const h=harness({total:1,status:()=>403});h.start();const r=await h.done;
  assert.equal(r.action,'downloadError');assert.equal(h.downloads.length,0);
  assert.equal(h.actions.filter(a=>a.action==='refreshScanPage').length,1);
  assert.equal(h.actions.find(a=>a.action==='refreshScanPage').noScroll,true);
});
test('grayscale original JPEGs use the matching PDF color space',async()=>{
  const gray=Buffer.from(jpeg);gray[11]=1;
  const h=harness({total:1,imageBytes:gray});h.start();await h.done;
  assert.equal(h.renders.length,0);assert.match(h.pdf(),/\/ColorSpace \/DeviceGray/);
});
test('concurrent mixed pages share font loads and never exceed four network requests',async()=>{
  const h=harness({total:8,pageHtml:n=>html(n,'<div class=text_layer><span class="ff4">Required text</span></div>')});
  h.start();assert.equal((await h.done).action,'downloadComplete');assert.equal(h.renders.length,8);
  assert.equal(h.fetched.filter(f=>f.url.endsWith('/fonts/0004.woff2')).length,1);assert.equal(h.maxActive,4);
});
for(const kind of ['image'])test(`a failed ${kind} on a mixed page never creates a PDF missing content`,async()=>{
  const h=harness({total:2,pageHtml:n=>html(n,'<div class=text_layer><span class="ff4">Required text</span></div>'),
    status:u=>(kind==='image'?u===imageUrl(2):u.endsWith('.woff2'))?404:200});
  h.start();assert.equal((await h.done).action,'downloadError');assert.equal(h.downloads.length,0);
});

test('a missing Scribd font falls back once per family and still exports every page with a warning',async()=>{
  const h=harness({total:3,pageHtml:n=>html(n,'<div class="text_layer"><div class="ff4"><span>Keep text</span></div></div>'),status:u=>u.endsWith('.woff2')?404:200});
  h.start();const result=await h.done;
  assert.equal(result.action,'downloadComplete');assert.equal(result.pdfPages,3);
  assert.equal(result.fontFallbackCount,1);assert.equal(h.downloads.length,1);
  assert.equal(h.renders.length,3);
});
test('a usable signed src is preferred over inaccessible orig on a mixed page',async()=>{
  const h=harness({total:1,pageHtml:n=>html(n,'<div class=text_layer>Keep text</div>').replace('/></div>',` src="${imageUrl(n)}?token=valid"/></div>`),
    status:u=>u===imageUrl(1)?403:200});
  h.start();assert.equal((await h.done).action,'downloadComplete');
  assert.equal(h.fetched.some(f=>f.url===imageUrl(1)),false);
  assert.equal((h.renders[0].page.html.match(/\bsrc=/g)||[]).length,1);
});
test('strict image validation runs before launching any asset downloads',async()=>{
  const h=harness({total:1,pageHtml:n=>html(n,'<img src="https://example.com/other.jpg"/><div class=text_layer>text</div>')});
  h.start();assert.equal((await h.done).action,'downloadError');
  assert.equal(h.fetched.filter(f=>f.url.includes('/images/')).length,0);assert.equal(h.downloads.length,0);
});
test('direct PNG conversion reuses fetched bytes and sends document identity to the renderer',async()=>{
  const h=harness({total:1,imageBytes:Buffer.from([137,80,78,71,13,10,26,10])});
  h.start({urls:[imageUrl(1).replace('.jpg','.png')]});await h.done;
  assert.equal(h.fetched.length,1);assert.equal(h.renders.length,1);assert.equal(h.renders[0].action,'renderScribdImage');
  assert.equal(h.renders[0].docId,'123');
});
test('a duplicate fast request never starts a second download',async()=>{
  const h=harness({total:5});h.start();h.start();await h.done;
  assert.equal(h.downloads.length,1);assert.equal(h.fetched.length,10);
});
test('unhandled original JPEG color spaces use the full decoder and reuse already downloaded bytes',async()=>{
  const cmyk=Buffer.from(jpeg);cmyk[11]=4;
  const h=harness({total:1,imageBytes:cmyk});h.start();assert.equal((await h.done).action,'downloadComplete');
  assert.equal(h.renders.length,1);assert.equal(h.fetched.filter(f=>f.url===imageUrl(1)).length,1);
});

test('CSS background images are embedded and share the page image download',async()=>{
  const h=harness({total:1,pageHtml:n=>html(n,'<div class="text_layer">Text</div>'),contextCss:`.x::before{content:"";background-image:url("${imageUrl(1)}")}`});
  h.start();assert.equal((await h.done).action,'downloadComplete');
  assert.match(h.renders[0].page.rendererCss,/background-image:url\("data:image\/jpeg;base64,/);
  assert.equal(h.fetched.filter(request=>request.url===imageUrl(1)).length,1);
});

test('an unavailable CSS image prevents an incomplete PDF and identifies the page',async()=>{
  const cssImage=base+'/images/background.png';
  const h=harness({total:1,pageHtml:n=>html(n,'<div class="text_layer">Text</div>'),contextCss:`.x{background-image:url("${cssImage}")}`,status:url=>url===cssImage?404:200});
  h.start();const result=await h.done;
  assert.equal(result.action,'downloadError');assert.match(result.error,/trang 1/);assert.equal(h.downloads.length,0);
});

test('mixed Scribd reports page stages before the first completed page and includes measured durations',async()=>{
  const h=harness({total:1,pageHtml:n=>html(n,'<div class="text_layer"><span class="ff4">Text</span></div>')});
  h.start();assert.equal((await h.done).action,'downloadComplete');
  const states=h.messages.filter(m=>m.action==='documentActivityUpdated');
  const logs=states.at(-1).logs;
  for(const stage of ['document_check','html','images','css','fonts','render','pdf','saving']){
    assert.ok(logs.some(l=>l.event==='stageStart'&&l.stage===stage),stage+' must start visibly');
    assert.ok(logs.some(l=>l.event==='stageComplete'&&l.stage===stage&&l.elapsedMs>=0),stage+' must finish with a duration');
  }
  const first=h.messages.findIndex(m=>m.action==='downloadProgress');
  assert.ok(h.messages.slice(0,first).some(m=>m.logs?.some(l=>l.event==='stageStart'&&l.pageNum===1)));
  assert.equal(states.at(-1).activeStages.length,0);
  assert.equal(h.downloads.length,1);
});

test('a slow CSS response publishes timed waiting logs without advancing completion and clears its timer',async()=>{
  let now=1000, cssReply, timerId=0;const callbacks=new Map();
  class Clock extends Date{static now(){return now;}}
  const timers={setTimeout(fn,delay){const id=++timerId;callbacks.set(id,{fn,delay});return id;},clearTimeout(id){callbacks.delete(id);}};
  const h=harness({total:1,clock:Clock,timers,pageHtml:n=>html(n,'<div class="text_layer">Text</div>'),
    onTab(m,reply){if(m.action==='getScribdRendererContext'){cssReply=()=>reply({ok:true,html:m.page.html,css:''});return true;}}});
  h.start();for(let n=0;n<50&&!cssReply;n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(typeof cssReply,'function');
  assert.ok([...callbacks.values()].some(t=>t.delay===5000));
  now+=5000;const pending=[...callbacks.values()];callbacks.clear();pending.forEach(t=>t.fn());
  let latest=h.messages.filter(m=>m.action==='documentActivityUpdated').at(-1);
  assert.equal(latest.downloadedCount,0);
  assert.ok(latest.logs.some(l=>l.event==='stageWait'&&l.stage==='css'&&l.pageNum===1&&l.elapsedMs===5000));
  assert.equal(h.downloads.length,0);
  cssReply();assert.equal((await h.done).action,'downloadComplete');
  latest=h.messages.filter(m=>m.action==='documentActivityUpdated').at(-1);
  assert.equal(latest.activeStages.length,0);assert.equal(callbacks.size,0);
  assert.equal(h.downloads.length,1);
});

test('stage logs expose a retry without extra requests and stop after a failed page',async()=>{
  const h=harness({total:1,status:(u,n)=>n===1?503:404});h.start();
  assert.equal((await h.done).action,'downloadError');
  const last=h.messages.filter(m=>m.action==='documentActivityUpdated').at(-1);
  assert.ok(last.logs.some(l=>l.event==='resourceRetry'));
  assert.ok(last.logs.some(l=>l.event==='stageError'&&l.stage==='html'));
  assert.equal(last.activeStages.length,0);assert.equal(h.downloads.length,0);
  assert.equal(h.fetched.length,2);
});

test('a failed renderer response is logged as a stage error rather than a completed render',async()=>{
  const h=harness({total:1,pageHtml:n=>html(n,'<div class="text_layer">Text</div>'),
    onTab(m,reply){if(m.action==='renderJsonpPageToImage'){reply({ok:false,error:'Cannot decode page'});return true;}}});
  h.start();assert.equal((await h.done).action,'downloadError');
  const logs=h.messages.filter(m=>m.action==='documentActivityUpdated').at(-1).logs;
  assert.ok(logs.some(l=>l.event==='stageError'&&l.stage==='render'));
  assert.equal(logs.some(l=>l.event==='stageComplete'&&l.stage==='render'),false);
  assert.equal(h.downloads.length,0);
});

test('aborting a pending CSS step clears waiting timers and suppresses late wait updates',async()=>{
  let cssReply,timerId=0;const callbacks=new Map();
  const timers={setTimeout(fn,delay){const id=++timerId;callbacks.set(id,{fn,delay});return id;},clearTimeout(id){callbacks.delete(id);}};
  const h=harness({total:1,timers,pageHtml:n=>html(n,'<div class="text_layer">Text</div>'),
    onTab(m,reply){if(m.action==='getScribdRendererContext'){cssReply=()=>reply({ok:true,html:m.page.html,css:''});return true;}}});
  h.start();for(let n=0;n<50&&!cssReply;n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(typeof cssReply,'function');const pending=[...callbacks.values()];
  vm.runInContext('scribdFastJobs.get(7).controller.abort()',h.context);
  assert.equal(callbacks.size,0);const before=h.messages.length;
  pending.forEach(t=>t.fn());assert.equal(h.messages.length,before);
  cssReply();assert.equal((await h.done).action,'downloadError');
  assert.equal(h.downloads.length,0);
});
