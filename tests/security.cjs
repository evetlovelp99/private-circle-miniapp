const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = require('path').resolve(__dirname, '..');
let actor = 'owner', rows, mediaCalls, deleteCalls;
const cmp=(op,v)=>({op,v});
const command={in:v=>cmp('in',v),lt:v=>cmp('lt',v),lte:v=>cmp('lte',v),gt:v=>cmp('gt',v),or:v=>cmp('or',v),and:v=>cmp('and',v)};
function matches(row,c) {
 if(c.op==='or')return c.v.some(x=>matches(row,x));
 if(c.op==='and')return c.v.every(x=>matches(row,x));
 return Object.entries(c).every(([k,v])=>v && v.op ? ({in:()=>v.v.includes(row[k]),lt:()=>row[k]<v.v,lte:()=>row[k]<=v.v,gt:()=>row[k]>v.v}[v.op])() : row[k]===v);
}
class Query {
 constructor(name,c={}){this.name=name;this.c=c;this.orders=[];this.offset=0;this.size=20;}
 where(c){this.c=c;return this;} orderBy(k,d){this.orders.push([k,d]);return this;} skip(n){this.offset=n;return this;}limit(n){this.size=n;return this;}
 async get(){let data=rows[this.name].filter(x=>matches(x,this.c)); data.sort((a,b)=>{for(const [k,d] of this.orders){if(a[k]!==b[k])return (a[k]<b[k]?-1:1)*(d==='desc'?-1:1);}return 0;});return {data:data.slice(this.offset,this.offset+this.size).map(x=>({...x}))};}
 async update({data}){const found=rows[this.name].filter(x=>matches(x,this.c));found.forEach(x=>Object.assign(x,data));return {stats:{updated:found.length}};}
 async add({data}){const id=data._id||`${this.name}-${rows[this.name].length}-${Math.random()}`;if(rows[this.name].some(x=>x._id===id))throw Error('duplicate');rows[this.name].push({...data,_id:id});return {_id:id};}
 doc(id){return {get:async()=>{const data=rows[this.name].find(x=>x._id===id);if(!data)throw Error('missing');return {data:{...data}};},remove:async()=>{rows[this.name]=rows[this.name].filter(x=>x._id!==id);return {stats:{removed:1}};}};}
}
const db={command,collection:n=>new Query(n)};
const cloud={init(){},database:()=>db,getWXContext:()=>({OPENID:actor}),getTempFileURL:async({fileList})=>{mediaCalls.push(fileList);return {fileList:fileList.map(fileID=>({fileID,tempFileURL:`https://media/${fileID}`,status:0}))};},deleteFile:async({fileList})=>{deleteCalls.push(fileList);return {fileList:fileList.map(fileID=>({fileID,status:0}))};}};
const env={OWNER_OPENID:'owner'};
function load(name){const sandbox={require:n=>n==='wx-server-sdk'?cloud:require(n),exports:{},process:{env},console:{error(){}},Date,Set};vm.runInNewContext(fs.readFileSync(`${root}/cloudfunctions/${name}/index.js`,'utf8'),sandbox);return sandbox.exports.main;}
const auth=load('auth'),admin=load('admin'),post=load('post');
function reset(){rows={users:[],relations:[],inviteCodes:[],posts:[],likes:[],comments:[]};mediaCalls=[];deleteCalls=[];actor='owner';env.OWNER_OPENID='owner';}
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
 console.log('PASS: owner fail-closed, input validation, atomic invite redemption, idempotent user creation, deterministic concurrent likes, cutoff query, tied timestamp pagination (45 posts), enrichment/detail (125 records), media permission/batching, cascading deletion');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
