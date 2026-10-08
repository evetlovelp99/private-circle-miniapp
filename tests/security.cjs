const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = require('path').resolve(__dirname, '..');
let actor = 'owner', rows, mediaCalls, deleteCalls, queryCalls;
const cmp=(op,v)=>({op,v});
const command={in:v=>cmp('in',v),lt:v=>cmp('lt',v),lte:v=>cmp('lte',v),gt:v=>cmp('gt',v),gte:v=>cmp('gte',v),or:v=>cmp('or',v),and:v=>cmp('and',v)};
function matches(row,c) {
 if(c.op==='or')return c.v.some(x=>matches(row,x));
 if(c.op==='and')return c.v.every(x=>matches(row,x));
 return Object.entries(c).every(([k,v])=>v && v.op ? ({in:()=>v.v.includes(row[k]),lt:()=>row[k]<v.v,lte:()=>row[k]<=v.v,gt:()=>row[k]>v.v,gte:()=>row[k]>=v.v}[v.op])() : row[k]===v);
}
class Query {
 constructor(name,c={}){this.name=name;this.c=c;this.orders=[];this.offset=0;this.size=20;}
 where(c){this.c=c;return this;} orderBy(k,d){this.orders.push([k,d]);return this;} skip(n){this.offset=n;return this;}limit(n){this.size=n;return this;}
 async get(){queryCalls.push({name:this.name,condition:this.c});let data=rows[this.name].filter(x=>matches(x,this.c)); data.sort((a,b)=>{for(const [k,d] of this.orders){if(a[k]!==b[k])return (a[k]<b[k]?-1:1)*(d==='desc'?-1:1);}return 0;});return {data:data.slice(this.offset,this.offset+this.size).map(x=>({...x}))};}
 async update({data}){const found=rows[this.name].filter(x=>matches(x,this.c));found.forEach(x=>Object.assign(x,data));return {stats:{updated:found.length}};}
 async add({data}){const id=data._id||`${this.name}-${rows[this.name].length}-${Math.random()}`;if(rows[this.name].some(x=>x._id===id))throw Error('duplicate');rows[this.name].push({...data,_id:id});return {_id:id};}
 doc(id){return {get:async()=>{const data=rows[this.name].find(x=>x._id===id);if(!data)throw Error('missing');return {data:{...data}};},remove:async()=>{rows[this.name]=rows[this.name].filter(x=>x._id!==id);return {stats:{removed:1}};}};}
}
const db={command,collection:n=>new Query(n)};
const cloud={init(){},database:()=>db,getWXContext:()=>({OPENID:actor}),getTempFileURL:async({fileList})=>{mediaCalls.push(fileList);return {fileList:fileList.map(fileID=>({fileID,tempFileURL:`https://media/${fileID}`,status:0}))};},deleteFile:async({fileList})=>{deleteCalls.push(fileList);return {fileList:fileList.map(fileID=>({fileID,status:0}))};}};
const env={OWNER_OPENID:'owner'};
function load(name, Clock=Date){const sandbox={require:n=>n==='wx-server-sdk'?cloud:require(n),exports:{},process:{env},console:{error(){}},Date:Clock,Set};vm.runInNewContext(fs.readFileSync(`${root}/cloudfunctions/${name}/index.js`,'utf8'),sandbox);return sandbox.exports.main;}
const auth=load('auth'),admin=load('admin'),post=load('post');
function reset(){rows={users:[],relations:[],inviteCodes:[],posts:[],likes:[],comments:[]};mediaCalls=[];deleteCalls=[];queryCalls=[];actor='owner';env.OWNER_OPENID='owner';}

async function previewTests() {
 reset();
 rows.users.push({_id:'owner',openid:'owner',nickname:'创建者'}, {_id:'member',openid:'member',nickname:'圈友'});
 rows.relations.push({_id:'r',ownerUserId:'owner',viewerUserId:'member',canViewUntil:'2026-10-08T00:00:00.000Z'});
 for (const id of ['p1','p2','empty']) rows.posts.push({_id:id,authorId:'owner',text:id,images:[],createdAt:'2026-10-07T00:00:00.000Z'});
 rows.posts.push({_id:'hidden',authorId:'owner',text:'hidden',images:[],createdAt:'2026-10-09T00:00:00.000Z'});
 for (let i=0;i<125;i++) rows.comments.push({_id:`old${i}`,postId:'p1',userId:'member',content:'older',createdAt:'2026-10-06T00:00:00.000Z'});
 rows.comments.push(
  {_id:'a',postId:'p1',userId:'member',content:'tie older',createdAt:'2026-10-07T12:00:00.000Z'},
  {_id:'z',postId:'p1',userId:'owner',content:'tie newer',createdAt:'2026-10-07T12:00:00.000Z'},
  {_id:'single',postId:'p2',userId:'missing-user',content:'single comment',createdAt:'2026-10-07T00:00:00.000Z'},
  {_id:'secret',postId:'hidden',userId:'owner',content:'secret comment',createdAt:'2026-10-09T00:00:00.000Z'}
 );
 actor='member';
 let result=await post({action:'listPosts'});
 const find=id=>result.data.find(p=>p._id===id);
 assert.equal(find('p1').commentCount,127);
 assert.deepEqual(Array.from(find('p1').previewComments,c=>c.content),['tie newer','tie older']);
 assert.equal(find('p1').previewComments[0].nickname,'创建者');
 assert.deepEqual(Object.keys(find('p1').previewComments[0]).sort(),['content','nickname']);
 assert.equal(find('p2').previewComments.length,1); assert.equal(find('p2').previewComments[0].nickname,'匿名');
 assert.equal(find('empty').previewComments.length,0);assert.ok(!find('hidden'));
 assert.ok(!JSON.stringify(result).includes('secret comment'));
 const commentQueries=queryCalls.filter(q=>q.name==='comments');
 assert.equal(commentQueries.length,2); // 128 comments, fetched in page-wide batches of 100.
 assert.ok(commentQueries.every(q=>q.condition.postId.op==='in' && q.condition.postId.v.length===3));
 await post({action:'addComment',postId:'p1',content:'newly added'});
 result=await post({action:'listPosts'});assert.equal(find('p1').previewComments[0].content,'newly added');
 const latest=rows.comments.find(c=>c.content==='newly added');
 await db.collection('comments').doc(latest._id).remove(); // Current model uses physical deletion.
 result=await post({action:'listPosts'});assert.equal(find('p1').previewComments[0].content,'tie newer');
 // Membership and post visibility are both required, including legacy own-post records.
 actor='stranger';rows.posts.push({_id:'own',authorId:'stranger',text:'own',images:[],createdAt:'2026-10-07T00:00:00.000Z'});
 rows.comments.push({_id:'own-comment',postId:'own',userId:'owner',content:'private content',createdAt:'2026-10-07T00:00:00.000Z'});
 result=await post({action:'listPosts'});assert.equal(find('own').previewComments.length,0);assert.ok(!JSON.stringify(result).includes('private content'));
 actor='owner';result=await post({action:'listPosts'});assert.equal(find('p1').previewComments.length,2);
 // Feed onShow already reloads the list after returning from detail.
 let page, refreshes=0;
 vm.runInNewContext(fs.readFileSync(`${root}/pages/feed/index.js`,'utf8'),{Page:x=>page=x,require:()=>({ensureAuthed:async()=>({nickname:'圈友'})}),console});
 page.setData=patch=>Object.assign(page.data,patch); page.refreshSessionFlags=async()=>({openid:'member'});
 page.loadStats=async()=>{};page.loadPosts=async()=>{refreshes++;};await page.onShow();await page.onShow();assert.equal(refreshes,2);
 console.log('PASS: comment previews (0/1/2+, newest/tied ordering, 100+ batching, nickname-only payload, membership/visibility, addition/removal, return refresh)');
}

async function nicknameTests() {
 reset();
 rows.users.push({_id:'owner',openid:'owner',nickname:'创建者'}, {_id:'member',openid:'member',nickname:'旧昵称',avatar:'unchanged'}, {_id:'legacy-member',openid:'member',nickname:'旧昵称'});
 rows.relations.push({_id:'r',ownerUserId:'owner',viewerUserId:'member',canViewUntil:'2026-01-01T00:00:00.000Z'});
 actor='member';
 const before=JSON.stringify(rows.users);
 for (const nickname of [undefined,null,123,'','   ','字'.repeat(13),'😀'.repeat(13)]) {
  const result=await auth({action:'updateNickname',nickname});assert.equal(result.ok,false);assert.ok(result.msg);
 }
 assert.equal(JSON.stringify(rows.users),before);
 for (const nickname of ['字','字'.repeat(12),'😀'.repeat(12)]) assert.equal((await auth({action:'updateNickname',nickname})).ok,true);
 const changed=await auth({action:'updateNickname',nickname:'  新昵称  ',openid:'owner'});
 assert.equal(changed.ok,true);assert.equal(changed.openid,'member');assert.equal(changed.user.nickname,'新昵称');
 assert.equal(rows.users.find(u=>u.openid==='owner').nickname,'创建者');
 assert.ok(rows.users.filter(u=>u.openid==='member').every(u=>u.nickname==='新昵称'));
 assert.equal(changed.user.avatar,'unchanged');
 assert.equal((await auth({action:'getSession'})).user.nickname,'新昵称');
 // Historical posts and comments resolve current names, without record migrations.
 rows.posts.push({_id:'p',authorId:'member',text:'old post',images:[],createdAt:'2025-01-01T00:00:00.000Z'});
 rows.comments.push({_id:'c',postId:'p',userId:'member',content:'old comment',createdAt:'2025-01-01T00:00:00.000Z'});
 const feed=await post({action:'listPosts'});assert.equal(feed.data[0].author.nickname,'新昵称');assert.equal(feed.data[0].previewComments[0].nickname,'新昵称');
 const detail=await post({action:'getPostDetail',postId:'p'});assert.equal(detail.post.author.nickname,'新昵称');assert.equal(detail.comments[0].user.nickname,'新昵称');
 actor='owner';assert.equal((await auth({action:'updateNickname',nickname:'新创建者'})).ok,true);
 actor='stranger';assert.equal((await auth({action:'updateNickname',nickname:'no'})).ok,false);
 rows.users.push({_id:'stranger',openid:'stranger',nickname:'no relation'});
 assert.equal((await auth({action:'updateNickname',nickname:'no'})).ok,false);
 actor='member';delete env.OWNER_OPENID;assert.equal((await auth({action:'updateNickname',nickname:'no'})).ok,false);
 env.OWNER_OPENID='owner';rows.users=rows.users.filter(u=>u.openid!=='member');assert.equal((await auth({action:'updateNickname',nickname:'no'})).ok,false);
 actor='owner';rows.users=rows.users.filter(u=>u.openid!=='owner');assert.equal((await auth({action:'updateNickname',nickname:'no'})).ok,false);

 // Exercise the real auth cache helper: it uses globalData, not wx storage.
 const app={globalData:{user:{openid:'member',nickname:'旧昵称'},openid:'123456789012345678901234'}};
 let response={ok:false,msg:'昵称须为1至12个字符'}, calls=0, release, networkFailure=false;
 const toasts=[], requests=[];
 const wx={cloud:{callFunction:async args=>{calls++;requests.push(args);if(networkFailure)throw Error('网络异常');return release?await new Promise(resolve=>{release=()=>resolve({result:response});}):{result:response};}},showToast:x=>toasts.push(x.title)};
 const helper={module:{exports:{}},getApp:()=>app,wx,Promise,Error};
 vm.runInNewContext(fs.readFileSync(`${root}/utils/auth.js`,'utf8'),helper);
 function client(name) {
  let page;
  vm.runInNewContext(fs.readFileSync(`${root}/pages/${name}/index.js`,'utf8'),{Page:x=>page=x,require:()=>helper.module.exports,getApp:()=>app,wx,console});
  page.data={...page.data};page.setData=patch=>Object.assign(page.data,patch);return page;
 }
 const me=client('me');await me.onShow();assert.equal(me.data.displayOpenid,'12345678…901234');
 me.openNicknameSheet();assert.equal(me.data.nicknameDraft,'旧昵称');
 me.onNicknameInput({detail:{value:'输入名字'}});me.onNicknameBlur({detail:{value:'微信昵称'}});assert.equal(me.data.nicknameDraft,'微信昵称');
 await me.saveNickname();assert.equal(toasts.at(-1),response.msg);assert.equal(me.data.nicknameSheetOpen,true);assert.equal(app.globalData.user.nickname,'旧昵称');
 networkFailure=true;await me.saveNickname();assert.equal(toasts.at(-1),'网络异常');assert.equal(me.data.nicknameSheetOpen,true);assert.equal(me.data.savingNickname,false);networkFailure=false;
 response={ok:true,user:{openid:'member',nickname:'新昵称'}};
 release=true;const pending=me.saveNickname({detail:{value:{nickname:'表单最终值'}}});
 await me.saveNickname();assert.equal(calls,3);me.closeNicknameSheet();assert.equal(me.data.nicknameSheetOpen,true);
 release();await pending;release=null;
 assert.equal(requests.at(-1).data.nickname,'表单最终值');assert.deepEqual(Object.keys(requests.at(-1).data).sort(),['action','nickname']);
 assert.equal(app.globalData.user.nickname,'新昵称');assert.equal(me.data.user.nickname,'新昵称');assert.equal(me.data.nicknameSheetOpen,false);assert.equal(toasts.at(-1),'已改名');
 const home=client('feed');home.refreshSessionFlags=async()=>({openid:'member'});home.loadPosts=async()=>{};home.loadStats=async()=>{};
 home.data.currentUser={nickname:'stale'};await home.onShow();assert.equal(home.data.currentUser.nickname,'新昵称');
 const publish=client('create');await publish.onShow();assert.equal(publish.data.currentUser.nickname,'新昵称');
 me.openNicknameSheet();me.onNicknameInput({detail:{value:'取消草稿'}});me.closeNicknameSheet();assert.equal(me.data.nicknameSheetOpen,false);assert.equal(me.data.user.nickname,'新昵称');
 console.log('PASS: nickname membership/ownership, Unicode boundaries/trim, legacy duplicates, historical names, blur/form values, cloud/network errors, duplicate submit, cache and feed/publish refresh');
}

async function nicknameSheetTests() {
 function fixture(support=true) {
  const app={globalData:{user:{openid:'member',nickname:'旧昵称'},openid:'member'}};
  const timers=new Map(),toasts=[],requests=[];let nextTimer=0,page;
  const tab={data:{hidden:false,selected:''},setData(p){Object.assign(this.data,p);},syncSelection(){this.data.selected='/pages/me/index';}};
  let result={ok:true,user:{openid:'member',nickname:'新昵称'}};
  const wx={showToast:x=>toasts.push(x.title),cloud:{callFunction:async args=>{requests.push(args);return {result};}}};
  if(support!==undefined && support!==null)wx.canIUse=key=>{assert.equal(key,'input.bindnicknamereview');return support;};
  vm.runInNewContext(fs.readFileSync(`${root}/pages/me/index.js`,'utf8'),{
   Page:x=>page=x,require:()=>({ensureAuthed:async()=>app.globalData.user}),getApp:()=>app,wx,console,
   setTimeout:(fn,delay)=>{assert.equal(delay,3000);const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)
  });
  page.data={...page.data,user:app.globalData.user};page.setData=p=>Object.assign(page.data,p);page.getTabBar=()=>tab;
  return {page,tab,toasts,requests,timers,app,setResult:r=>result=r,expire(){for(const fn of [...timers.values()])fn();}};
 }
 // Unchanged prefill closes without a request, toast or review wait.
 let f=fixture();await f.page.onShow();assert.equal(f.tab.data.hidden,false);assert.equal(f.tab.data.selected,'/pages/me/index');
 f.page.openNicknameSheet();assert.equal(f.tab.data.hidden,true);await f.page.saveNickname();assert.equal(f.requests.length,0);assert.equal(f.toasts.length,0);assert.equal(f.tab.data.hidden,false);
 // Missing canIUse and unsupported events both save normally.
 for(const support of [false,null]) {
  f=fixture(support);f.page.openNicknameSheet();f.page.onNicknameBlur({detail:{value:'新昵称'}});await f.page.saveNickname();
  assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);assert.equal(f.tab.data.hidden,false);
 }
 // Simulator/no callback fallback waits exactly 3 seconds; waiting is not saving.
 f=fixture();f.page.openNicknameSheet();f.page.onNicknameInput({detail:{value:'新昵称'}});
 let pending=f.page.saveNickname();assert.equal(f.requests.length,0);assert.equal(f.page.data.savingNickname,false);assert.equal(f.timers.size,1);
 await f.page.saveNickname();assert.equal(f.timers.size,1);f.expire();await pending;assert.equal(f.requests.length,1);assert.equal(f.tab.data.hidden,false);assert.equal(f.timers.size,0);
 // A passing callback releases the wait immediately, including form final-value changes.
 f=fixture();f.page.openNicknameSheet();pending=f.page.saveNickname({detail:{value:{nickname:'新昵称'}}});assert.equal(f.requests.length,0);
 f.page.onNicknameReview({detail:{pass:true}});await pending;assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);
 // Explicit failure blocks retries and later pass callbacks until the value changes.
 f=fixture();f.page.openNicknameSheet();f.page.onNicknameInput({detail:{value:'不通过'}});pending=f.page.saveNickname();
 f.page.onNicknameReview({detail:{pass:false}});await pending;assert.equal(f.requests.length,0);assert.equal(f.tab.data.hidden,true);assert.equal(f.page.data.nicknameSheetOpen,true);
 assert.equal(f.toasts.at(-1),'这个名字没通过微信检测，换一个吧');f.page.onNicknameReview({detail:{pass:true}});await f.page.saveNickname();assert.equal(f.requests.length,0);
 f.page.onNicknameBlur({detail:{value:'新昵称'}});pending=f.page.saveNickname();f.expire();await pending;assert.equal(f.requests.length,1);
 // Already-reviewed values must not be invalidated by blur carrying the same value.
 f=fixture();f.page.openNicknameSheet();f.page.onNicknameInput({detail:{value:'新昵称'}});f.page.onNicknameReview({detail:{pass:true}});
 f.page.onNicknameBlur({detail:{value:'新昵称'}});await f.page.saveNickname();assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);
 // Closing, leaving the page, or editing during a wait cancels the queued save.
 for(const action of ['close','hide','edit']) {
  f=fixture();f.page.openNicknameSheet();f.page.onNicknameInput({detail:{value:'新昵称'}});pending=f.page.saveNickname();
  if(action==='close')f.page.closeNicknameSheet();else if(action==='hide')f.page.onHide();else f.page.onNicknameInput({detail:{value:'另一个'}});
  await pending;f.expire();assert.equal(f.requests.length,0);assert.equal(f.timers.size,0);
  if(action!=='edit') {assert.equal(f.tab.data.hidden,false);assert.equal(f.page.data.nicknameSheetOpen,false);}
 }
 // Cloud rejection leaves the sheet open and tabBar hidden, with no stuck saving state.
 f=fixture(false);f.setResult({ok:false,msg:'云端拒绝'});f.page.openNicknameSheet();f.page.onNicknameInput({detail:{value:'新昵称'}});await f.page.saveNickname();
 assert.equal(f.page.data.savingNickname,false);assert.equal(f.page.data.nicknameSheetOpen,true);assert.equal(f.tab.data.hidden,true);assert.equal(f.toasts.at(-1),'云端拒绝');
 f.page.closeNicknameSheet();assert.equal(f.tab.data.hidden,false);f.page.openNicknameSheet();f.page.onHide();await f.page.onShow();assert.equal(f.tab.data.hidden,false);assert.equal(f.tab.data.selected,'/pages/me/index');
 // Both absent and temporarily unmounted custom tabBar handles are safe.
 f=fixture();delete f.page.getTabBar;await f.page.onShow();f.page.openNicknameSheet();f.page.closeNicknameSheet();f.page.onHide();
 f.page.getTabBar=()=>undefined;await f.page.onShow();f.page.openNicknameSheet();f.page.onHide();
 console.log('PASS: sheet/tabBar lifecycle, unchanged prefill, unsupported API, 3s fallback, explicit fail/change, blur/form review, wait cancellation, retry state');
}

async function statsTests() {
 reset();
 const hour=3600000, start=Date.parse('2026-10-08T07:00:00.000Z');
 let now=start+12*hour;
 class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
 const stats=load('auth',Clock);
 const payload={action:'getStats',dayStart:start,dayEnd:start+24*hour};
 const iso=t=>new Date(t).toISOString();
 rows.users.push({_id:'m',openid:'member'},{_id:'dup',openid:'member'},{_id:'orphan',openid:'orphan'});
 rows.relations.push({_id:'r',ownerUserId:'owner',viewerUserId:'member',canViewUntil:iso(start+hour)},
  {_id:'r2',ownerUserId:'owner',viewerUserId:'member',canViewUntil:iso(start+hour)},
  {_id:'missing',ownerUserId:'owner',viewerUserId:'no-profile'});
 // Owner counts even before bootstrap; duplicates and incomplete memberships do not.
 let result=await stats(payload);assert.equal(result.ok,true);assert.equal(result.memberCount,2);assert.equal(result.todayPostCount,0);
 for(const [id,authorId,time] of [
  ['before','owner',start-1],['start','owner',start],['cutoff','owner',start+hour],
  ['after-cutoff','owner',start+hour+1],['end','owner',start+24*hour],
  ['own','member',start+2*hour],['secret','stranger',start+hour]
 ])rows.posts.push({_id:id,authorId,createdAt:iso(time),text:id,images:[]});
 actor='member';result=await stats({...payload,openid:'owner'});assert.equal(result.todayPostCount,3);
 const feed=await post({action:'listPosts'});
 assert.equal(result.todayPostCount,feed.data.filter(p=>p.createdAt>=iso(start)&&p.createdAt<iso(payload.dayEnd)).length);
 for(const id of ['stranger','orphan','no-profile']){actor=id;assert.equal((await stats({...payload,openid:'owner'})).ok,false);}
 actor='member';delete env.OWNER_OPENID;assert.equal((await stats(payload)).ok,false);env.OWNER_OPENID='owner';
 actor='owner';
 for(const patch of [
  {dayStart:undefined},{dayEnd:undefined},{dayStart:String(start)},{dayEnd:null},
  {dayStart:NaN},{dayEnd:Infinity},{dayStart:-Infinity},
  {dayEnd:start+23*hour-1},{dayEnd:start+25*hour+1},
  {dayStart:start-7*24*hour,dayEnd:start-6*24*hour}
 ]){const rejected=await stats({...payload,...patch});assert.equal(rejected.ok,false);assert.ok(rejected.msg);}
 for(const t of [start-hour,start+25*hour]){now=t;assert.equal((await stats(payload)).ok,true);}
 for(const t of [start-hour-1,start+25*hour+1]){now=t;assert.equal((await stats(payload)).ok,false);}
 // Actual local-midnight DST dates, independent of the machine running the suite.
 const oldTZ=process.env.TZ;
 try {
  process.env.TZ='America/Los_Angeles';
  for(const [month,day,hours] of [[2,8,23],[10,1,25]]){
   const dayStart=new Date(2026,month,day).getTime(),dayEnd=new Date(2026,month,day+1).getTime();
   assert.equal(dayEnd-dayStart,hours*hour);now=dayStart+12*hour;
   assert.equal((await stats({action:'getStats',dayStart,dayEnd})).ok,true);
  }
 } finally {if(oldTZ===undefined)delete process.env.TZ;else process.env.TZ=oldTZ;}
 reset();now=start+12*hour;
 for(let i=0;i<125;i++){
  rows.users.push({_id:`u${i}`,openid:`u${i}`});
  rows.relations.push({_id:`r${i}`,ownerUserId:'owner',viewerUserId:`u${i}`});
  rows.posts.push({_id:`p${i}`,authorId:'owner',createdAt:iso(start+i),text:'',images:[]});
 }
 for(let i=0;i<110;i++)rows.users.push({_id:`legacy${i}`,openid:'u0'});
 result=await stats(payload);assert.equal(result.memberCount,126);assert.equal(result.todayPostCount,125);
 actor='u0';assert.equal((await stats(payload)).todayPostCount,125);
 // Viewer relationships must also span batches, with the same visibility as feed.
 for(let i=0;i<125;i++){
  rows.relations.push({_id:`v${i}`,ownerUserId:`other${i}`,viewerUserId:'u0'});
  rows.posts.push({_id:`other${i}`,authorId:`other${i}`,createdAt:iso(start+hour)});
 }
 assert.equal((await stats(payload)).todayPostCount,250);
 let page, calls=[], response={ok:true,memberCount:2,todayPostCount:0}, fail=false, release;
 const wx={cloud:{callFunction:async args=>{calls.push(args);if(fail)throw Error('offline');return release?await new Promise(resolve=>{release=resolve;}):{result:response};}},stopPullDownRefresh(){},showToast(){},showModal:async options=>options.success({confirm:true})};
 vm.runInNewContext(fs.readFileSync(`${root}/pages/feed/index.js`,'utf8'),{Page:x=>page=x,require:()=>({ensureAuthed:async()=>({})}),wx,Date:Clock,console});
 page.setData=patch=>Object.assign(page.data,patch);
 release=true;const pending=page.loadStats();assert.equal(page.data.todayPostCount,'–');
 release({result:response});release=null;await pending;assert.equal(page.data.todayPostCount,0);
 const local=new Clock();assert.equal(calls.at(-1).data.dayStart,new Date(local.getFullYear(),local.getMonth(),local.getDate()).getTime());
 assert.equal(calls.at(-1).data.dayEnd,new Date(local.getFullYear(),local.getMonth(),local.getDate()+1).getTime());
 const previousTZ=process.env.TZ;
 try {
  process.env.TZ='America/Los_Angeles';
  for(const [month,day,hours] of [[2,8,23],[10,1,25]]){
   now=new Date(2026,month,day,12).getTime();await page.loadStats();
   const sent=calls.at(-1).data;assert.equal(sent.dayStart,new Date(2026,month,day).getTime());
   assert.equal(sent.dayEnd-sent.dayStart,hours*hour);
   assert.equal((await stats(sent)).ok,true);
  }
 } finally {if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;}
 response={ok:false,msg:'rejected'};await page.loadStats();assert.equal(page.data.memberCount,'--');assert.equal(page.data.todayPostCount,'--');
 fail=true;await page.loadStats();assert.equal(page.data.todayPostCount,'--');fail=false;
 response={ok:true,memberCount:2,todayPostCount:4};await page.loadStats();assert.equal(page.data.todayPostCount,4);
 release=true;const stale=page.loadStats();const finishStale=release;release=null;await page.loadStats();finishStale({result:{ok:true,memberCount:9,todayPostCount:99}});await stale;assert.equal(page.data.todayPostCount,4);
 let refreshes=0,lists=0;page.loadStats=async()=>{refreshes++;};page.loadPosts=async()=>{lists++;};page.refreshSessionFlags=async()=>({});
 await page.onShow();await page.onPullDownRefresh();await page.onDeletePost({currentTarget:{dataset:{id:'p'}}});
 assert.equal(refreshes,3);assert.equal(lists,3);
 response={ok:false,msg:'delete rejected'};await page.onDeletePost({currentTarget:{dataset:{id:'p'}}});
 assert.equal(refreshes,3);assert.equal(lists,3);
 console.log('PASS: stats membership/deduplication, 100+ batching, feed visibility/cutoff, local midnight/DST, validation/grace boundaries, start-inclusive/end-exclusive, loading/failure/races and refresh lifecycle');
}

async function run(){
 reset();delete env.OWNER_OPENID;assert.equal((await admin({action:'createInviteCode'})).ok,false);assert.equal((await auth({action:'bootstrapOwner'})).ok,false);
 env.OWNER_OPENID='owner';actor='stranger';assert.equal((await auth({action:'bootstrapOwner'})).ok,false);assert.equal((await post({action:'createPost',text:'x',images:[]})).ok,false);
 actor='owner';await Promise.all([auth({action:'bootstrapOwner'}),auth({action:'bootstrapOwner'})]);assert.equal(rows.users.length,1);assert.equal(rows.users[0]._id,'owner');
 assert.equal((await auth({action:'verifyInvite',code:123})).ok,false);
 for(const payload of [{text:12,images:[]},{text:'x'.repeat(1001),images:[]},{text:'',images:[]},{text:'ok',images:['https://evil']},{text:'ok',images:[],audioFileId:null},{text:'ok',images:[],liveMotionFileId:'cloud://env/a'}])assert.equal((await post({action:'createPost',...payload})).ok,false);
 const generated=await admin({action:'createInviteCode'});assert.match(generated.code,/^[A-HJ-NP-Z2-9]{12}$/);assert.ok(Date.parse(generated.expiresAt)>Date.now());
 actor='member';const redeemed=await Promise.all([auth({action:'verifyInvite',code:generated.code}),auth({action:'verifyInvite',code:generated.code})]);assert.equal(redeemed.filter(x=>x.ok).length,1);assert.equal(rows.relations.length,1);assert.ok(rows.users.some(x=>x._id==='member'));
 rows.inviteCodes.push({_id:'expired',code:'EXPIRED',used:false,createdBy:'owner',expiresAt:'2020-01-01T00:00:00.000Z'});assert.equal((await auth({action:'verifyInvite',code:'EXPIRED'})).ok,false);
 rows.posts.push({_id:'p',authorId:'owner',text:'x',images:[],createdAt:'2026-01-01T00:00:00.000Z'});
 for(const content of ['', ' '.repeat(4),'x'.repeat(501),123])assert.equal((await post({action:'addComment',postId:'p',content})).ok,false);
 assert.equal((await post({action:'addComment',postId:'p',content:' hi '})).ok,true);assert.equal(rows.comments[0].content,'hi');
 await Promise.all([post({action:'toggleLike',postId:'p'}),post({action:'toggleLike',postId:'p'})]);assert.equal(rows.likes.length,1);assert.equal(rows.likes[0]._id,'p_member');
 assert.equal((await post({action:'toggleLike',postId:'p'})).liked,false);assert.equal(rows.likes.length,0);
 reset();actor='member';rows.relations.push({_id:'r',ownerUserId:'owner',viewerUserId:'member',canViewUntil:'2026-01-01T00:00:00.000Z'});
 for(let i=0;i<55;i++)rows.posts.push({_id:`hidden${i}`,authorId:'owner',text:'hidden',images:['cloud://env/secret'],createdAt:'2026-02-01T00:00:00.000Z'});
 for(let i=0;i<45;i++)rows.posts.push({_id:`p${String(i).padStart(2,'0')}`,authorId:'owner',text:'visible',images:Array.from({length:9},(_,j)=>`cloud://env/${i}-${j}`),createdAt:'2026-01-01T00:00:00.000Z'});
 for(let i=0;i<125;i++){rows.likes.push({_id:`l${i}`,postId:'p44',userId:`u${i}`});rows.comments.push({_id:`c${i}`,postId:'p44',userId:`u${i}`,content:'c',createdAt:'2026-01-01T00:00:00.000Z'});rows.users.push({_id:`u${i}`,openid:`u${i}`,nickname:'N'});}
 let page=await post({action:'listPosts'});assert.equal(page.data.length,20);assert.equal(page.data[0].likeCount,125);assert.equal(page.data[0].commentCount,125);assert.ok(mediaCalls.every(x=>x.length<=50));assert.ok(!Object.keys(page.mediaUrls).includes('cloud://env/secret'));
 const ids=page.data.map(x=>x._id);while(page.hasMore){page=await post({action:'listPosts',...page.nextCursor});ids.push(...page.data.map(x=>x._id));}assert.equal(ids.length,45);assert.equal(new Set(ids).size,45);
 const detail=await post({action:'getPostDetail',postId:'p44'});assert.equal(detail.comments.length,125);assert.ok(detail.comments.every(x=>x.user.nickname==='N'));
 actor='stranger';const calls=mediaCalls.length;assert.equal((await post({action:'getPostDetail',postId:'p44'})).ok,false);assert.equal(mediaCalls.length,calls);
 actor='owner';rows.posts.find(x=>x._id==='p44').audio='cloud://env/audio';assert.equal((await post({action:'deletePost',postId:'p44'})).ok,true);assert.equal(rows.likes.length,0);assert.equal(rows.comments.length,0);assert.ok(deleteCalls.flat().includes('cloud://env/audio'));assert.ok(!rows.posts.some(x=>x._id==='p44'));
 // Client business failures must preserve the comment/cutoff drafts and avoid reloading.
 const toasts=[];
 function client(name) {
   let definition;
   const wx={cloud:{callFunction:async()=>({result:{ok:false,msg:'server rejected'}})},showToast:x=>toasts.push(x.title)};
   vm.runInNewContext(fs.readFileSync(`${root}/pages/${name}/index.js`,'utf8'),{
     require:()=>({ensureAuthed:async()=>({})}),Page:x=>definition=x,wx,console
   });
   definition.data={...definition.data};
   definition.setData=function(patch){Object.assign(this.data,patch);};
   return definition;
 }
 const adminPage=client('admin');adminPage.data.viewerOpenid='member';await adminPage.silentCutoff();assert.equal(adminPage.data.viewerOpenid,'member');
 const detailPage=client('post');detailPage.data.content='draft';detailPage.loadDetail=()=>{throw Error('unexpected reload');};await detailPage.submitComment();assert.equal(detailPage.data.content,'draft');
 const feedPage=client('feed');feedPage.loadPosts=()=>{throw Error('unexpected reload');};await feedPage.onLikeTap({currentTarget:{dataset:{id:'p'}}});
 assert.ok(toasts.every(x=>x==='server rejected'));
 await previewTests();
 await nicknameTests();
 await nicknameSheetTests();
 await statsTests();
 console.log('PASS: owner fail-closed, input validation, atomic invite redemption, idempotent user creation, deterministic concurrent likes, cutoff query, tied timestamp pagination (45 posts), enrichment/detail (125 records), media permission/batching, cascading deletion');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
