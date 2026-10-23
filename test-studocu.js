const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const support = fs.existsSync('./studocu.js') ? require('./studocu.js') : {};
const asset = '243173bb01b3daa39da5a8dcdbab0f75';
const image = `https://doc-assets.studocu.com/${asset}/html/bg1a.png?Policy=valid&Signature=signed`;
const font = `https://website-assets.studocu.com/fonts/document_fonts/${asset}/f1.woff`;

test('recognizes Studocu document IDs without confusing Scribd IDs or lookalike hosts', () => {
  assert.equal(typeof support.getDocumentId, 'function');
  assert.equal(support.getDocumentId('https://www.studocu.vn/vn/document/school/course/name/140212022?sid=123'), '140212022');
  assert.equal(support.getDocumentId('https://www.studocu.com/en-us/document/school/course/name/42'), '42');
  for (const url of ['https://www.scribd.com/document/42', 'https://studocu.vn.evil.test/vn/document/a/42', 'https://www.studocu.vn/vn/course/a/42']) {
    assert.equal(support.getDocumentId(url), null);
  }
});

test('embeds the real signed image and font, preserving geometry and text CSS', async () => {
  assert.equal(typeof support.preparePage, 'function');
  const fetched = [];
  const result = await support.preparePage({pageNum:27,assetId:asset,width:842.04,height:595.44,
    html:`<div class="pf"><img src="${image.replaceAll('&','&amp;')}" loading="lazy"><div class="t ff1 x1">Tiếng Việt</div></div>`},
    `.p2hv .x1{left:558.359px}@font-face{font-family:ff1;src:url("${font}") format("woff")}`,
    async url => { fetched.push(url); return url === font ? 'data:font/woff;base64,FONT' : 'data:image/png;base64,IMAGE'; });
  assert.deepEqual(fetched.sort(), [font,image].sort());
  assert.equal(result.site, 'studocu');
  assert.equal(result.pageNum,27);
  assert.equal(result.width,842.04);
  assert.equal(result.height,595.44);
  assert.match(result.html, /class="p2hv"/);
  assert.match(result.html, /Tiếng Việt/);
  assert.match(result.html, /data:image\/png;base64,IMAGE/);
  assert.doesNotMatch(result.html, /loading="lazy"|https:\/\//);
  assert.match(result.fontCss, /left:558.359px/);
  assert.match(result.fontCss, /data:font\/woff;base64,FONT/);
  assert.match(result.fontCss, /margin:0/);
});

test('does not substitute the hexadecimal background filename for the actual page number', async () => {
  assert.equal(typeof support.preparePage, 'function');
  const page=await support.preparePage({pageNum:27,assetId:asset,width:595,height:842,html:`<img src="${image}">`},'.p2hv .t{position:absolute}',async()=> 'data:image/png;base64,IMAGE');
  assert.equal(page.pageNum,27);
});

test('rejects assets belonging to a different document before making any request', async () => {
  assert.equal(typeof support.preparePage, 'function');
  let requests=0;
  await assert.rejects(support.preparePage({pageNum:1,assetId:asset,width:595,height:842,
    html:'<img src="https://doc-assets.studocu.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/html/bg1.png">'},'',async()=>{requests++;}),/tài liệu|asset/i);
  assert.equal(requests,0);
});

test('fails an image or font fetch instead of returning an incomplete page', async () => {
  assert.equal(typeof support.preparePage, 'function');
  await assert.rejects(support.preparePage({pageNum:1,assetId:asset,width:595,height:842,html:`<img src="${image}">`},'',async()=>{throw new Error('HTTP 403');}),/HTTP 403/);
});

test('embeds Word Form fonts from the legacy Studocu CloudFront CDN under the current asset ID',async()=>{
  const legacyFont=`https://d20ohkaloyme4g.cloudfront.net/fonts/document_fonts/${asset}/f1.woff`;
  const fetched=[];
  const page=await support.preparePage({pageNum:1,assetId:asset,width:595,height:842,html:'<div class="t ff1">Word Form</div>'},
    `@font-face{font-family:ff1;src:url("${legacyFont}") format("woff")}`,
    async url=>{fetched.push(url);return 'data:font/woff;base64,FONT';});
  assert.deepEqual(fetched,[legacyFont]);
  assert.match(page.fontCss,/data:font\/woff;base64,FONT/);
  assert.doesNotMatch(page.fontCss,/https:/);
  const permissions=JSON.parse(fs.readFileSync('./manifest.json','utf8')).host_permissions;
  assert.ok(permissions.some(pattern=>legacyFont.startsWith(pattern.replace(/\*$/,''))), 'font fetch needs extension host permission');
});

test('legacy CloudFront support rejects other documents, non-font paths, HTTP and lookalike hosts before fetching',async()=>{
  const base='https://d20ohkaloyme4g.cloudfront.net';
  const urls=[`${base}/fonts/document_fonts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/f1.woff`,
    `${base}/images/${asset}/bg1.png`,`${base}/fonts/document_fonts/${asset}/f1.js`,
    `${base}/fonts/document_fonts/${asset}/../other/f1.woff`,
    `http://d20ohkaloyme4g.cloudfront.net/fonts/document_fonts/${asset}/f1.woff`,
    `https://d20ohkaloyme4g.cloudfront.net.evil.test/fonts/document_fonts/${asset}/f1.woff`];
  for(const url of urls){
    let requests=0;
    await assert.rejects(support.preparePage({pageNum:1,assetId:asset,width:595,height:842,html:'<div class="t">Word Form</div>'},
      `@font-face{src:url("${url}")}`,async()=>{requests++;return ''; }),/Asset/);
    assert.equal(requests,0);
  }
});

test('a permanently missing font falls back like the browser without dropping page text or images',async()=>{
  const gone=`https://d20ohkaloyme4g.cloudfront.net/fonts/document_fonts/${asset}/f1.woff`;
  const page=await support.preparePage({pageNum:1,assetId:asset,width:595,height:842,html:`<img src="${image}"><div class="t ff1">Word Form tiếng Việt</div>`},
    `@font-face{font-family:ff1;src:url("${gone}")} .ff1{font-family:ff1}.t{left:10px}`,
    async url=>{if(url===gone){const e=new Error('HTTP 404');e.status=404;throw e;}return 'data:image/png;base64,IMAGE';});
  assert.deepEqual(page.missingFonts,[gone]);
  assert.match(page.html,/Word Form tiếng Việt/);assert.match(page.html,/data:image\/png/);
  assert.doesNotMatch(page.fontCss,/@font-face|cloudfront/);
  assert.match(page.fontCss,/left:10px/);
});

test('a missing page image still fails instead of exporting incomplete content',async()=>{
  for(const [url,status] of [[image,404]]){
    await assert.rejects(support.preparePage({pageNum:1,assetId:asset,width:595,height:842,html:`<img src="${image}">`},
      `@font-face{src:url("${font}")}`,async value=>{if(value===url){const e=new Error('HTTP '+status);e.status=status;throw e;}return 'data:image/png;base64,IMAGE';}),/HTTP/);
  }
});

test('a denied Studocu font falls back while preserving all text and images',async()=>{
  const page=await support.preparePage({pageNum:1,assetId:asset,width:595,height:842,html:`<img src="${image}"><div class="t">Keep text</div>`},
    `@font-face{font-family:ff1;src:url("${font}")} .t{font-family:ff1,Arial}`,async value=>{
      if(value===font){const error=new Error('HTTP 403');error.status=403;throw error;}return 'data:image/png;base64,IMAGE';
    });
  assert.deepEqual(page.missingFonts,[font]);assert.match(page.html,/Keep text/);assert.match(page.html,/data:image\/png/);
  assert.doesNotMatch(page.fontCss,/@font-face/);
});

function controllerHarness({indices=[0,1,2],loaded=indices,cache={},restricted=false,docId='140212022'}={}) {
  const stored=structuredClone(cache),messages=[],scrolls=[];
  const win={location:{href:`https://www.studocu.vn/vn/document/school/course/name/${docId}`},
    setTimeout(fn){queueMicrotask(fn);},scrollTo(){},getComputedStyle(node){return{width:'595px',height:'842px',filter:node.blurred?'blur(4px)':'none',visibility:'visible',display:node.hidden?'none':'block'};}};
  let present=loaded;
  let beforeWait=()=>{};
  win.setTimeout=fn=>{beforeWait();queueMicrotask(fn);};
  const pageNodes=indices.map(index=>{
    const url=`https://doc-assets.studocu.com/${asset}/html/bg${(index+1).toString(16)}.png?Policy=valid`;
    const img={src:url,currentSrc:url,complete:true,naturalWidth:1190,naturalHeight:1684,setAttribute(){},removeAttribute(){},attributes:[]};
    const html=()=>`<div class="pf w0 h0"><div class="page-content" style="display:none"><div class="pc"><img src="${img.currentSrc}"><div class="t ff1">Trang ${index+1}</div></div></div></div>`;
    const pf={get outerHTML(){return html();},cloneNode(){return{get outerHTML(){return html();},querySelectorAll:selector=>selector==='img'?[img]:[]};}};
    const node={getAttribute:name=>name==='data-page-index'?String(index):null,
      querySelector:selector=>selector==='.pf'&&present.includes(index)?pf:selector==='.pc'&&present.includes(index)?{}:null,
      querySelectorAll:selector=>selector==='img'&&present.includes(index)?[img]:selector==='.t'&&present.includes(index)?[{textContent:'Trang'}]:[],
      scrollIntoView(){scrolls.push(index+1);},parentElement:null};
    return node;
  });
  const root={parentElement:{innerText:restricted?'This is a preview Go Premium and unlock all 3 pages':''},
    querySelectorAll:selector=>selector==='[data-page-index]'?pageNodes:[],
    querySelector:selector=>pageNodes.find((_,i)=>selector.includes(`"${i}"`))||null};
  for(const node of pageNodes)node.parentElement=root;
  const document={defaultView:win,body:{innerText:root.parentElement.innerText},
    querySelector:selector=>selector==='#document-wrapper'?root:null,
    styleSheets:[{href:`https://doc-assets.studocu.com/${asset}/html/${asset}.css`,cssRules:[{cssText:'.p2hv .pf{position:relative}'},{cssText:'.p2hv .t{position:absolute}'}]}]};
  const chrome={runtime:{sendMessage(value){messages.push(value);return Promise.resolve();}},storage:{local:{
    async get(keys){return Object.fromEntries(keys.filter(k=>k in stored).map(k=>[k,structuredClone(stored[k])]));},
    async set(value){Object.assign(stored,structuredClone(value));}
  }}};
  return{stored,messages,scrolls,win,window:win,document,chrome,setLoaded(value){present=value;},setBeforeWait(fn){beforeWait=fn;}};
}

test('Studocu inspection caches complete page HTML without scrolling and restores it after reload',async()=>{
  assert.equal(typeof support.createController,'function');
  const h=controllerHarness(),c=support.createController(h);
  const state=await c.inspect();
  assert.equal(state.complete,true);assert.equal(state.count,3);assert.equal(state.site,'studocu');
  assert.equal(h.scrolls.length,0);
  const again=controllerHarness({loaded:[0],cache:h.stored});
  const restored=await support.createController(again).inspect();
  assert.equal(restored.complete,true);assert.equal(restored.count,3);
  assert.equal(again.scrolls.length,0);
  assert.equal(h.stored['scribdScan:140212022'],undefined);
});

test('a gap in DOM page indices cannot be mistaken for a complete document',async()=>{
  assert.equal(typeof support.createController,'function');
  const state=await support.createController(controllerHarness({indices:[0,2]})).inspect();
  assert.equal(state.totalPages,3);assert.equal(state.complete,false);
  assert.deepEqual(state.missingPages,[2]);
});

test('Word Form keeps all 111 pages and collects existing HTML without waiting for 16 lazy images',async()=>{
  const indices=Array.from({length:111},(_,i)=>i);
  const missing=[55,56,57];
  const h=controllerHarness({indices,loaded:indices.filter(i=>!missing.includes(i)),docId:'56109361'});
  const root=h.document.querySelector('#document-wrapper');
  const lazy=[50,51,52,53,54,55,59,60,61,62,63,64,65,82,90,95];
  for(const n of lazy){
    const img=root.querySelectorAll('[data-page-index]')[n-1].querySelectorAll('img')[0];
    img.complete=false;img.naturalWidth=0;img.naturalHeight=0;
  }
  const controller=support.createController(h);
  const state=await controller.inspect();
  assert.equal(state.totalPages,111);
  assert.equal(state.count,108);
  assert.deepEqual(state.missingPages,[56,57,58]);
  assert.equal(state.complete,false);
  const page=await controller.getPage({docId:'56109361',pageNum:50});
  assert.match(page.page.html,/bg32\.png/);
  assert.equal(h.scrolls.length,0);
  h.setBeforeWait(()=>h.setLoaded(indices));
  await controller.start(()=>{});
  assert.deepEqual(h.scrolls,[56]);
  assert.equal((await controller.inspect()).complete,true);
  assert.equal((await controller.inspect()).count,111);
});

test('an unloaded image still needs an allowed document source before its HTML is collected',async()=>{
  const h=controllerHarness();
  const img=h.document.querySelector('#document-wrapper').querySelectorAll('[data-page-index]')[1].querySelectorAll('img')[0];
  img.complete=false;img.naturalWidth=0;
  img.currentSrc=img.src='https://example.com/unrelated.png';
  const state=await support.createController(h).inspect();
  assert.equal(state.count,2);
  assert.deepEqual(state.missingPages,[2]);
});

test('a transient smaller DOM cannot shrink the cached document total or discard captured pages',async()=>{
  const first=controllerHarness();await support.createController(first).inspect();
  const reopened=controllerHarness({indices:[0],cache:first.stored});
  const state=await support.createController(reopened).inspect();
  assert.equal(state.totalPages,3);assert.equal(state.count,3);assert.equal(state.complete,true);
});

test('root and per-page blur gates invalidate ready cache even without a Premium notice',async()=>{
  for(const wholeRoot of [true,false]){
    const h=controllerHarness(),c=support.createController(h);await c.inspect();
    const root=h.document.querySelector('#document-wrapper');
    if(wholeRoot)root.blurred=true;
    else root.querySelectorAll('[data-page-index]')[1].querySelector('.pf').blurred=true;
    assert.equal((await c.inspect()).complete,false);
  }
});

test('invalidating an unavailable page persists until its asset URL changes',async()=>{
  const h=controllerHarness(),c=support.createController(h);await c.inspect();
  await c.invalidate({docId:'140212022',pageNum:2});
  let state=await c.inspect();assert.equal(state.complete,false);assert.deepEqual(state.missingPages,[2]);
  const reloaded=controllerHarness({cache:h.stored});
  assert.equal((await support.createController(reloaded).inspect()).complete,false);
  const img=h.document.querySelector('#document-wrapper').querySelectorAll('[data-page-index]')[1].querySelectorAll('img')[0];
  img.currentSrc=img.src.replace('Policy=valid','Policy=new');img.src=img.currentSrc;
  state=await c.inspect();assert.equal(state.complete,true);
});

test('refresh waits through an unchanged expired URL for the genuinely fresh page asset',async()=>{
  const h=controllerHarness(),c=support.createController(h);await c.inspect();
  const img=h.document.querySelector('#document-wrapper').querySelectorAll('[data-page-index]')[1].querySelectorAll('img')[0];
  let waits=0;
  h.setBeforeWait(()=>{if(++waits===2)img.currentSrc=img.src=img.src.replace('Policy=valid','Policy=new');});
  const result=await c.getPage({docId:'140212022',pageNum:2},true);
  assert.equal(waits,2);assert.match(result.page.html,/Policy=new/);
});

test('refresh accepts an already-fresh asset when the failed URL disappeared before the request arrived',async()=>{
  const h=controllerHarness(),c=support.createController(h);await c.inspect();
  const img=h.document.querySelector('#document-wrapper').querySelectorAll('[data-page-index]')[1].querySelectorAll('img')[0];
  const old=img.src;img.currentSrc=img.src=old.replace('Policy=valid','Policy=new');
  const result=await c.getPage({docId:'140212022',pageNum:2,rejectedUrl:old},true);
  assert.match(result.page.html,/Policy=new/);assert.equal((await c.inspect()).complete,true);
});

test('reload retains required cached CSS while the live stylesheet inventory is temporarily absent',async()=>{
  const first=controllerHarness();
  first.document.styleSheets.push({href:`https://doc-assets.studocu.com/${asset}/html/extra.css`,get cssRules(){throw new Error('CORS');}});
  await support.createController(first).inspect();
  const reopened=controllerHarness({cache:first.stored});reopened.document.styleSheets=[];
  const page=await support.createController(reopened).getPage({docId:'140212022',pageNum:1});
  assert.match(page.css,/position:relative/);
  assert.deepEqual(page.stylesheetUrls,[`https://doc-assets.studocu.com/${asset}/html/extra.css`]);
});

test('unknown dependencies from unreadable CSS stay failed until an explicit supplementary scan retries them',async()=>{
  assert.equal(typeof support.pageFingerprint,'function');
  const h=controllerHarness(),c=support.createController(h);
  h.document.styleSheets.push({href:`https://doc-assets.studocu.com/${asset}/html/extra.css`,get cssRules(){throw new Error('CORS');}});
  const data=await c.getPage({docId:'140212022',pageNum:1});
  await assert.rejects(c.getPage({docId:'140212022',pageNum:1,rejectedUrl:font,
    rejectedFingerprint:support.pageFingerprint(data.page,data.css,data.stylesheetUrls)},true),/chưa tải|làm mới/i);
  assert.equal((await c.inspect()).complete,false);
  await c.start(()=>{});assert.equal((await c.inspect()).complete,true);
});

test('manual scan can retry an unknown failed dependency immediately after restoring its cache',async()=>{
  const h=controllerHarness(),c=support.createController(h);
  const data=await c.getPage({docId:'140212022',pageNum:1});
  await c.invalidate({docId:'140212022',pageNum:1,rejectedUrl:font,
    rejectedFingerprint:support.pageFingerprint(data.page,data.css,[])});
  const again=controllerHarness({cache:h.stored}),reloaded=support.createController(again);
  await reloaded.start(()=>{});assert.equal((await reloaded.inspect()).complete,true);
});

test('empty loading CSSOM sheets are all fetched instead of silently replacing cached layout',async()=>{
  const h=controllerHarness();
  h.document.styleSheets[0].cssRules=[];
  h.document.styleSheets.push({href:`https://doc-assets.studocu.com/${asset}/html/extra.css`,cssRules:[]});
  const data=await support.createController(h).getPage({docId:'140212022',pageNum:1});
  assert.equal(data.stylesheetUrls.length,2);assert.equal(data.css,'');
});

test('relative CSS URLs are resolved and unreadable document sheets are requested explicitly',async()=>{
  const h=controllerHarness();
  h.document.styleSheets[0].cssRules.push({cssText:'@font-face{font-family:ff1;src:url("f1.woff")}'});
  h.document.styleSheets.push({href:`https://doc-assets.studocu.com/${asset}/html/extra.css`,get cssRules(){throw new Error('CORS');}});
  const page=await support.createController(h).getPage({docId:'140212022',pageNum:1});
  assert.match(page.css,new RegExp(`${asset}/html/f1.woff`));
  assert.deepEqual(page.stylesheetUrls,[`https://doc-assets.studocu.com/${asset}/html/extra.css`]);
});

test('a Premium notice does not block fully loaded pages or their cache',async()=>{
  assert.equal(typeof support.createController,'function');
  const h=controllerHarness();await support.createController(h).inspect();
  const controller=support.createController(controllerHarness({cache:h.stored,restricted:true}));
  const state=await controller.inspect();
  assert.equal(state.complete,true);assert.equal(state.count,3);
  assert.equal((await controller.getPage({docId:'140212022',pageNum:1})).ok,true);
});

test('a Premium notice does not change missing-page coverage or hide loaded pages',async()=>{
  const controller=support.createController(controllerHarness({loaded:[0],restricted:true}));
  const state=await controller.inspect();
  assert.equal(state.complete,false);assert.deepEqual(state.missingPages,[2,3]);
  assert.equal((await controller.getPage({docId:'140212022',pageNum:1})).ok,true);
  await assert.rejects(controller.getPage({docId:'140212022',pageNum:2}),/chưa tải/i);
});

test('supplementary scan visits only missing pages and completes when lazy content arrives',async()=>{
  assert.equal(typeof support.createController,'function');
  const h=controllerHarness({loaded:[0,2]}),c=support.createController(h);
  await c.inspect();h.setBeforeWait(()=>h.setLoaded([0,1,2]));
  await c.start(()=>{});
  assert.deepEqual(h.scrolls,[2]);assert.equal((await c.inspect()).complete,true);
  assert.equal(h.messages.at(-1).action,'scanComplete');
});

test('stopping during async scan startup prevents scrolling or an automatic download',async()=>{
  assert.equal(typeof support.createController,'function');
  const h=controllerHarness({loaded:[0]}),c=support.createController(h);
  const starting=c.start(()=>{});c.stop();await starting;
  assert.equal(h.scrolls.length,0);
  assert.equal(h.messages.some(m=>m.action==='scanComplete'),false);
});

test('page requests for a different document are rejected after navigation',async()=>{
  assert.equal(typeof support.createController,'function');
  const h=controllerHarness(),c=support.createController(h);await c.inspect();
  h.win.location.href='https://www.studocu.vn/vn/document/a/b/c/999';
  await assert.rejects(c.getPage({docId:'140212022',pageNum:1}),/tài liệu/i);
});

function backgroundHarness({restricted=false,missing=false,fail=false,stale=false,missingFont=false,badFont=false}={}) {
  const downloads=[], messages=[], renders=[], refreshes=[],fetches=[];
  let listener;
  const jpeg=Uint8Array.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
  const state={site:'studocu',docId:'140212022',assetId:asset,totalPages:2,count:missing?1:2,complete:!missing,restricted,isScanning:false};
  const scope=vm.createContext({console:{log(){}},URL,Uint8Array,Buffer,atob,btoa,StudocuSupport:support,AbortController,setTimeout,clearTimeout,
    fetch:async url=>{
      fetches.push(url);
      if(missingFont&&String(url).includes('.woff'))return{ok:false,status:404};
      if(fail || (stale && String(url).includes('Policy=old')))return{ok:false,status:403};
      return{ok:true,headers:{get:()=>String(url).includes('.woff')?'font/woff':'image/png'},arrayBuffer:async()=>Uint8Array.from([1,2,3]).buffer};
    },
    chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}},sendMessage(msg){messages.push(msg);return Promise.resolve();}},
      downloads:{async download(value){downloads.push(value);return 1;}},
      tabs:{sendMessage(tabId,request,callback){
        if(tabId!==8)throw new Error('Wrong tab');
        if(request.action==='getScanState'){assert.equal(request.mode,'html');return callback(state);}
        if(request.action==='getStudocuPage'||request.action==='refreshStudocuPage'){
          if(request.action==='refreshStudocuPage')refreshes.push(request.pageNum);
          const url=stale&&request.action==='getStudocuPage'?image.replace('Policy=valid','Policy=old'):image;
          return callback({ok:true,site:'studocu',docId:state.docId,assetId:asset,css:`@font-face{font-family:ff1;src:url("${font}")}`,
            page:{pageNum:request.pageNum,assetId:asset,width:595,height:842,html:`<div class="pf"><img src="${url.replaceAll('&','&amp;')}"><div class="t">Trang ${request.pageNum}</div></div>`}});
        }
        if(request.action==='invalidateStudocuPage')return callback({ok:true});
        if(request.action==='renderJsonpPageToImage'){
          renders.push(request.page);
          return callback({ok:true,fontFallbacks:[...(request.page.missingFonts||[]).map(family=>({family})),...(badFont?[{family:'ff1',reason:'decode'}]:[])],dataUrl:'data:image/jpeg;base64,'+Buffer.from(jpeg).toString('base64')});
        }
        throw new Error('Unexpected content action '+request.action);
      }}}});
  vm.runInContext(fs.readFileSync('./background.js','utf8'),scope);
  return{downloads,messages,renders,refreshes,fetches,run:()=>new Promise(resolve=>listener({action:'downloadImages',site:'studocu',urls:[],docId:'140212022',expectedPages:2,tabId:8},{},resolve))};
}

test('full worker caches font 404 once per job and reports fallback while exporting all pages',async()=>{
  const h=backgroundHarness({missingFont:true});await h.run();
  assert.equal(h.downloads.length,1);assert.equal(h.renders.length,2);
  assert.equal(h.fetches.filter(u=>String(u).includes('.woff')).length,1);
  assert.equal(h.refreshes.length,0);
  assert.equal(h.messages.find(m=>m.action==='downloadComplete').fontFallbackCount,1);
  assert.ok(h.renders.every(p=>!p.fontCss.includes('@font-face')));
});

test('Studocu worker reports undecodable font fallback once across multiple completed pages',async()=>{
  const h=backgroundHarness({badFont:true});await h.run();
  assert.equal(h.downloads.length,1);assert.equal(h.renders.length,2);
  assert.equal(h.messages.find(m=>m.action==='downloadComplete').fontFallbackCount,1);
});

test('Studocu download renders every captured page and writes one PDF through the background listener',async()=>{
  assert.equal(typeof support.preparePage,'function');
  const h=backgroundHarness();await h.run();
  assert.equal(h.downloads.length,1);
  assert.equal(h.downloads[0].filename,'studocu_140212022/document.pdf');
  const pdf=Buffer.from(h.downloads[0].url.split(',')[1],'base64').toString('latin1');
  assert.match(pdf,/\/Count 2\b/);
  assert.match(pdf,/\/MediaBox \[0 0 595 842\]/);
  assert.deepEqual(h.renders.map(p=>p.pageNum),[1,2]);
  assert.ok(h.renders.every(p=>p.site==='studocu'&&!p.html.includes('https://')));
  assert.equal(h.messages.filter(m=>m.action==='downloadComplete').length,1);
});

test('missing or unavailable Studocu pages never produce a partial PDF',async()=>{
  for(const options of [{missing:true},{fail:true}]){
    const h=backgroundHarness(options);await h.run();
    assert.equal(h.downloads.length,0);
    assert.equal(h.messages.some(m=>m.action==='downloadComplete'),false);
    assert.equal(h.messages.some(m=>m.action==='downloadError'),true);
  }
});

test('download ignores legacy Premium metadata when the actual page collection is complete',async()=>{
  const h=backgroundHarness({restricted:true});await h.run();
  assert.equal(h.downloads.length,1);
  assert.equal(h.messages.some(m=>m.action==='downloadComplete'),true);
});

test('an expired Studocu asset refreshes only that page and retries the complete HTML representation',async()=>{
  assert.equal(typeof support.preparePage,'function');
  const h=backgroundHarness({stale:true});await h.run();
  assert.deepEqual(h.refreshes,[1,2]);
  assert.equal(h.downloads.length,1);
  assert.ok(h.renders.every(p=>p.html.includes('class="t"')));
});

function popupHarness({missingScript=false,restricted=false,missing=false}={}){
  const elements=new Map(),sent=[],injected=[];
  let domReady;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{style:{},disabled:false,textContent:'',innerHTML:'',scrollHeight:0,
      classList:{remove(){},add(){}},addEventListener(){},appendChild(child){this.textContent+=child.textContent;}});
    return elements.get(id);
  };
  const state={site:'studocu',mode:'html',docId:'140212022',totalPages:34,count:missing?1:34,complete:!missing,ready:!missing,restricted,urls:[],isScanning:false};
  const runtime={lastError:null,onMessage:{addListener(){},removeListener(){}},sendMessage(message){sent.push(message);return Promise.resolve(message.action==='startStudocuTask'?{taskId:'T',docId:'140212022',tabId:8,mode:'html',totalPages:34,count:34,status:'downloading',active:true}:{});}};
  const scope=vm.createContext({console,URL,StudocuSupport:support,document:{
    getElementById:element,createElement:()=>({textContent:''}),addEventListener(name,fn){if(name==='DOMContentLoaded')domReady=fn;}
  },chrome:{runtime,tabs:{async query(){return[{id:8,windowId:1,url:'https://www.studocu.vn/vn/document/school/course/name/140212022'}];},
    sendMessage(id,message,callback){
      if(missingScript){missingScript=false;runtime.lastError={message:'Receiving end does not exist'};callback();return;}
      runtime.lastError=null;callback(message.action==='getDocInfo'?{docId:'140212022',site:'studocu',totalPages:34}:state);
    }},scripting:{executeScript(options,callback){injected.push(options.files);runtime.lastError=null;callback();}},
    storage:{local:{set(value,callback){if(callback)callback();}}}}});
  vm.runInContext(fs.readFileSync('./popup.js','utf8'),scope);
  return{scope,elements,sent,injected,start:()=>domReady()};
}

test('popup recognizes a Studocu tab and restores its download-ready state',async()=>{
  const h=popupHarness();await h.start();
  assert.equal(h.elements.get('status-ready').style.display,'block');
  assert.equal(h.elements.get('btn-download').disabled,false);
  assert.equal(h.elements.get('total-pages').textContent,34);
});

test('Studocu popup downloads cached page HTML even though its URL candidate list is empty',async()=>{
  const h=popupHarness();await h.start();await vm.runInContext('downloadPDF()',h.scope);
  const starts=h.sent.filter(m=>m.action==='startStudocuTask');assert.equal(starts.length,1);
  assert.equal(starts[0].docId,'140212022');assert.equal(starts[0].tabId,8);
});

test('fallback injection loads the Studocu adapter before the shared content script',async()=>{
  const h=popupHarness({missingScript:true});await h.start();
  assert.deepEqual(Array.from(h.injected[0]||[]),['studocu.js','content.js']);
  assert.equal(h.elements.get('btn-download').disabled,false);
});

test('popup uses page completeness rather than legacy Premium metadata',async()=>{
  const h=popupHarness({restricted:true});await h.start();
  assert.equal(h.elements.get('btn-download').disabled,false);
  assert.doesNotMatch(h.elements.get('log').textContent,/bản giới hạn|quyền xem|Premium/i);
});

test('popup keeps the download button disabled when pages are missing',async()=>{
  const h=popupHarness({missing:true});await h.start();
  assert.equal(h.elements.get('btn-download').disabled,true);
});

test('content script renders Studocu page in renderJsonpPageToImage and checks docId correctly',async()=>{
  let listener;
  class MockElement {
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.innerHTML='';}
    setAttribute(k,v){this.attrs[k]=v;}
    appendChild(child){this.children.push(child);}
    get firstChild(){return this.children[0];}
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);}
  }
  class MockCanvas {
    constructor(){this.width=0;this.height=0;}
    getContext(){return{fillRect(){},drawImage(){}};}
    toDataURL(){return'data:image/jpeg;base64,mockjpeg';}
  }
  class MockXMLSerializer {
    serializeToString(node){return'<div class="mock">serialized</div>';}
  }
  class MockCSSStyleSheet {
    constructor(){this.cssRules=[];}
    replaceSync(){}
  }
  class MockImage {
    constructor(){this.naturalWidth=595;this.naturalHeight=842;}
    set src(_){queueMicrotask(()=>this.onload&&this.onload());}
  }
  const scope=vm.createContext({
    console:{log(){}},
    URL,
    setTimeout,clearTimeout,
    StudocuSupport:support,
    XMLSerializer:MockXMLSerializer,
    CSSStyleSheet:MockCSSStyleSheet,
    Image:MockImage,
    document:{
      createElement(tag){
        if(tag==='canvas')return new MockCanvas();
        return new MockElement(tag);
      },
      querySelector(){return null;},
      querySelectorAll(){return[];}
    },
    window:{
      location:{href:'https://www.studocu.vn/vn/document/school/course/name/140212022'}
    },
    chrome:{
      runtime:{
        onMessage:{addListener(fn){listener=fn;}}
      },
      storage:{local:{get:async()=>({})}}
    }
  });
  vm.runInContext(fs.readFileSync('./content.js','utf8'),scope);
  const send=request=>new Promise(resolve=>listener(request,{},resolve));

  // Same docId should succeed
  const result=await send({
    action:'renderJsonpPageToImage',
    site:'studocu',
    docId:'140212022',
    page:{pageNum:1,site:'studocu',width:595,height:842,html:'<div>Trang 1</div>',fontCss:''},
    scale:2
  });
  assert.equal(result.ok,true);
  assert.equal(result.dataUrl,'data:image/jpeg;base64,mockjpeg');

  // Mismatched docId should be rejected
  const mismatch=await send({
    action:'renderJsonpPageToImage',
    site:'studocu',
    docId:'999999999',
    page:{pageNum:1,site:'studocu',width:595,height:842,html:'<div>Trang 1</div>',fontCss:''},
    scale:2
  });
  assert.equal(mismatch.ok,false);
  assert.match(mismatch.error,/chuyển sang tài liệu khác/i);
});

