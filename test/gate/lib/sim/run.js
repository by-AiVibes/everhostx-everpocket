const {fork}=require('child_process');const fs=require('fs');const crypto=require('crypto');
const H=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,10);
const N=(p,x={})=>({pubkey:p,contractId:'c',isUnl:true,lifeMoments:1,targetLifeMoments:1,owner:1,status:{status:1,onLcl:1},domain:'d'+p,peerPort:1,activeOnLcl:1,host:'rHost'+p,name:'tok'+p,...x});
const os=require('os');const {DIST}=require('../env');
async function scen(name,o){const ROOT=fs.mkdtempSync(os.tmpdir()+'/gate-sim-');globalThis.__errs={};const ids=['A','B','C','D','E'];
 const rng=o.rng||Math.random;const lf=ROOT+'/ledger.json';const L={validated:10000,lag:{},txs:{},seq0:5,hash:{}};
 for(let i=9000;i<12000;i++)L.hash[i]=crypto.createHash('sha256').update('ledger'+i).digest('hex').toUpperCase();const dirs={};
 for(const id of ids){const d=`${ROOT}/${id}`;fs.mkdirSync(d);dirs[id]=d;
  fs.writeFileSync(d+'/acquires.json',JSON.stringify({acquiredNodes:[],pendingAcquires:[]}));
  fs.writeFileSync(d+'/cluster.json',JSON.stringify({initialized:true,nodes:o.nodes,pendingNodes:[]}));
  fs.writeFileSync(d+'/operations.json',JSON.stringify({operations:o.ops}));
  fs.writeFileSync(d+'/cfg.json',JSON.stringify({unl:ids,max_input_ledger_offset:10,consensus:{roundtime:1000,stage_slice:100},evernode:{feeCeiling:'5000',hosts:['rH1','rH2','rH3'],anchorLedger:10000,tenantSequence:5,checkpointInterval:8,checkpointWindow:3}}));}
 let div=0,first=null,aborts=0,stat={},anchors=[],seqs=new Set(),votes=0,inputs=[];
 for(let r=0;r<(o.rounds||20);r++){const lcl=500+r*4;L.lag=o.lag?o.lag(r,L):{};if(process.env.TRACE){try{const q=JSON.parse(require('fs').readFileSync(ROOT+'/A/operations.json'));console.error('R'+r,'v'+L.validated,JSON.stringify(q.operations.map(x=>x.ref+'#'+x.attempt+'@'+x.nextAttemptLcl)),'seq'+q.agreedTenantSequence,'cons'+JSON.stringify(q.consumedTenantSequences||[]),'ext'+JSON.stringify(q.agreedExtendResults||{}).slice(0,100))}catch(e){console.error('tr',e.message)}}
  for(const id of ids)if(L.lag[id]==null&&o.jitter)L.lag[id]=L.validated-Math.floor(rng()*12);
  fs.writeFileSync(lf,JSON.stringify(L));fs.writeFileSync(lf+'.ops','');
  const inF=`${ROOT}/in-r${r}.json`;fs.writeFileSync(inF,JSON.stringify(o.inject?o.inject(r,inputs):inputs));
  const res={},kids={};
  for(const id of ids)kids[id]=fork(__dirname+'/node.js',[id,dirs[id],ids.join(','),(o.modes?o.modes(id,r):'ok')||'ok',String(lcl),lf,inF,`${ROOT}/out-${id}.json`],{env:{...process.env,DIST}});
  await new Promise(ok=>{for(const id of ids){kids[id].on('error',()=>{});kids[id].on('exit',()=>{if(!res[id]){res[id]={aborted:true,err:'exit',f:['','','']};if(Object.keys(res).length===ids.length)ok();}});kids[id].on('message',m=>{if(m.done){res[id]=m;kids[id].kill();if(Object.keys(res).length===ids.length)ok();return}
   for(const to of ids)if(to!==m.from&&kids[to].connected)kids[to].send(m,()=>{})})}});
  for(const line of fs.readFileSync(lf+'.ops','utf8').split('\n').filter(Boolean)){const e=JSON.parse(line);stat[e.k]=(stat[e.k]||0)+1;
   if(e.k==='tx'){const cur=L.seq0+Object.keys(L.txs).length;if(!L.txs[e.h]&&e.lls>=L.validated+1&&e.seq===cur){L.txs[e.h]={ledger:L.validated+1,rc:e.rc,lls:e.lls,seq:e.seq,fee:e.fee,ref:e.ref};seqs.add(e.seq+'@'+e.lls);}}}
  L.validated+=4;
  // next round consensus input set: same ordered list, partial delivery
  inputs=[];for(const id of ids){const p=`${ROOT}/out-${id}.json`;if(fs.existsSync(p)){const m=JSON.parse(fs.readFileSync(p));fs.unlinkSync(p);if(!(o.drop&&rng()<o.drop))inputs.push(m);}}
  for(const id of ids){if(res[id].voteUsed)votes++;if(res[id].err){globalThis.__errs=globalThis.__errs||{};globalThis.__errs[res[id].err.slice(0,120)]=res[id].err.slice(0,120);}}
  const live=ids.filter(i=>!res[i].aborted);aborts+=ids.length-live.length;
  const sig=i=>res[i].f.map(H).join('/');const cnt={};for(const i of live)cnt[sig(i)]=(cnt[sig(i)]||0)+1;
  if(Object.keys(cnt).length>1){div++;if(!first)first={ops:Object.fromEntries(live.map(i=>[i,JSON.parse(res[i].f[0]).operations.map(q=>q.ref+"#"+q.attempt+"@"+q.nextAttemptLcl).join(",")+"|anc"+JSON.parse(res[i].f[0]).anchorLedger])),r,d:ids.map(i=>`${i}${res[i].aborted?'(ab)':''}=${sig(i)}`).join(' ')}}
  const maj=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0];const src=maj&&live.find(i=>sig(i)===maj[0]);
  if(src){anchors.push(JSON.parse(res[src].f[0]).anchorLedger);for(const i of ids)['operations.json','cluster.json','acquires.json'].forEach((f,k)=>fs.writeFileSync(dirs[i]+'/'+f,res[src].f[k]));}}
 const fin=JSON.parse(fs.readFileSync(dirs.A+'/operations.json'));
 const out={errs:[...new Set(Object.values(globalThis.__errs||{}))],name,rounds:o.rounds||20,divergentRounds:div,aborts,votesUsed:votes,landedTxs:Object.keys(L.txs).length,landedPerOp:Object.values(L.txs).reduce((a,t)=>(a[t.ref]=(a[t.ref]||0)+1,a),{}),distinctSeqLls:[...seqs],events:stat,opsLeft:fin.operations.map(q=>`${q.type}:${q.ref}#${q.attempt}`),anchorFirst:anchors[0],anchorLast:anchors[anchors.length-1],agreedSeq:fin.agreedTenantSequence,first};
 out.initialOps=o.ops.map(q=>q.ref);out.landedRefs=Object.values(L.txs).map(t=>t.ref);fs.rmSync(ROOT,{recursive:true,force:true});if(process.env.GATE_VERBOSE)console.log(JSON.stringify(out));return out;}
const EXT=p=>({type:'extend_node',ref:p,data:{nodePubkey:p,moments:2},attempt:0,nextAttemptLcl:0});
const m32=a=>()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
const NODES=[...'ABCDE'].map(p=>N(p,{targetLifeMoments:1}));
// landed tx count per op ref (ref recorded as opRef|nodePubkey by the fake submit)
function landedPerOp(out){const c={};for(const r of out.initialOps)c[r]=0;for(const k of out.landedRefs){const r=String(k).split('|')[0];c[r]=(c[r]||0)+1;}return c;}
module.exports={scen,N,EXT,m32,NODES,landedPerOp};
