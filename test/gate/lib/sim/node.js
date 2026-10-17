// Test-only fake node process: real dist ClusterContext over a file-backed fake Xahau ledger.
const fs=require('fs');const crypto=require('crypto');
const {ClusterContext,VoteContext,EvernodeContext,XrplContext}=require(process.env.DIST);
const [id,dir,ids,mode,lcl,lf,inF,outF]=[process.argv[2],process.argv[3],process.argv[4].split(','),process.argv[5],+process.argv[6],process.argv[7],process.argv[8],process.argv[9]];
const modes=new Set(mode.split('+'));process.chdir(dir);if(process.env.DBG!==id){console.log=()=>{};console.error=()=>{};}
const L=JSON.parse(fs.readFileSync(lf));const myVal=L.lag[id]!=null?L.lag[id]:L.validated;
const seqAt=i=>{let s=L.seq0;for(const t of Object.values(L.txs))if(t.ledger<=i)s++;return s};
const emit=o=>fs.appendFileSync(lf+'.ops',JSON.stringify({...o,from:id,lcl})+'\n');
const vc=new VoteContext({unl:{send:async m=>{if(modes.has('novote'))return;process.send({from:id,msg:m.toString('base64')})}}});
process.on('message',x=>vc.feedUnlMessage({publicKey:x.from},Buffer.from(x.msg,'base64')));
let voteUsed=false;const ov=vc.vote.bind(vc);vc.vote=(...a)=>{voteUsed=true;return ov(...a)};
const hp={publicKey:id,contractId:'c',lclSeqNo:lcl,lclHash:crypto.createHash('sha256').update('l'+lcl).digest('hex'),timestamp:1700000000000,
 getContractConfig:async()=>JSON.parse(fs.readFileSync('cfg.json')),getContractUnl:()=>ids.map(p=>({publicKey:p})),
 updateContractConfig:async c=>fs.writeFileSync('cfg.json',JSON.stringify(c)),updatePeers:async()=>{},checkLiveness:async()=>true};
const lagChk=i=>{if(myVal<i)throw new Error('lag')};
const backend={getValidatedLedgerIndex:()=>myVal,
 getTxAt:async(h,i)=>{lagChk(i);if(modes.has('txnull'))return null;const t=L.txs[h];return t&&t.ledger<=i?{hash:h,resultCode:t.rc,lastLedgerSequence:t.lls}:null},
 getSignerListAt:async i=>{lagChk(i);return {signerQuorum:1,signerList:[]}},getAccountSequenceAt:async(a,i)=>{if(modes.has('seqfail'))throw new Error('reader fail');lagChk(i);return seqAt(i)},getAccountTxAt:async()=>[]};
const x=Object.create(XrplContext.prototype);Object.assign(x,{hpContext:hp,voteContext:vc,xahauLedger:backend,xrplAcc:{address:'rTenantSim'},
 multiSigner:{isSignerNode:()=>false,getSigner:()=>null},signerListInfo:{signerQuorum:1,signerList:[]},bootstrapForRound:async()=>{},reconcileValidatedTransactions:async()=>{},deinit:async()=>{}});
const ev=Object.create(EvernodeContext.prototype);ev.acquireData=JSON.parse(fs.readFileSync('acquires.json'));
const mySubmits=[];
Object.assign(ev,{hpContext:hp,voteContext:vc,xrplContext:x,bootstrapForRound:async()=>{},finishRoundInit:async()=>{},
 deinit:async(ab)=>{if(!ab)fs.writeFileSync('acquires.json',JSON.stringify(ev.acquireData))},getEvernodeConfig:()=>({momentSize:3600}),
 acquireNode:async()=>{emit({k:'ADD_EXECUTED'});throw 'x'},
 extendSubmit:async(host,m,name,opts)=>{const t=opts.txSubmitInfo;const nodePubkey=name.slice(3);
  const canon={account:'rTenantSim',sequence:t.sequence,lastLedgerSequence:t.maxLedgerSequence,fee:t.fee,host,nodePubkey,moments:m,tokenId:name};
  const o={};for(const k of Object.keys(canon).sort())o[k]=canon[k];
  const canonHash='0x'+crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  // REAL mode: on-ledger hash is hash of signed blob (differs from contract's canonical JSON hash)
  const h=process.env.GATE_CANON_HASH!=='1'?crypto.createHash('sha512').update('signed|'+JSON.stringify(o)).digest('hex').slice(0,64).toUpperCase():canonHash;
  if(modes.has('extfail'))throw 'fail before submit';
  emit({k:'tx',h,rc:'tesSUCCESS',lls:t.maxLedgerSequence,seq:t.sequence,fee:t.fee,ref:opts.extendOpRef+'|'+nodePubkey});
  mySubmits.push({ref:nodePubkey,opRef:opts.extendOpRef,hash:h,lastLedgerSequence:t.maxLedgerSequence,resultCode:'tesSUCCESS'});
  if(modes.has('throwafter'))throw 'timeout after submit';return {hash:h}}});
(async()=>{let err=null,aborted=false;const c=new ClusterContext(ev);
 try{const inputs=fs.existsSync(inF)?JSON.parse(fs.readFileSync(inF)):[];
  // consensus input set: identical ordered list for every node
  const users=new Map();for(const m of inputs){if(!users.has(m.user))users.set(m.user,[]);users.get(m.user).push(Buffer.from(m.payload))}
  const list=[...users.entries()].map(([pk,bufs])=>({publicKey:pk,inputs:bufs.map((_,j)=>[pk,j])}));
  await c.processConsensusUserInputs({list:()=>list,read:async([pk,j])=>users.get(pk)[j]});
  await c.init();aborted=c.isRoundAborted();}catch(e){err=String(e);aborted=true}
 await c.deinit().catch(()=>{});
 // OUT-OF-BAND observation (sidecar): never touches state dir
 if(!modes.has('crash')){const idx=Math.floor(myVal/8)*8;let hash=L.hash[idx]||('H'+idx);let vi=idx;
  if(modes.has('liehash'))hash='FAKE'+id;let tseq=seqAt(idx);if(modes.has('collude')){hash='COLLUDE'+idx;tseq=99;}if(modes.has('lieidx'))vi=idx+800;
  fs.writeFileSync(outF,JSON.stringify({user:modes.has('nonunl')?'edOUTSIDER':id,payload:JSON.stringify({type:'anchor_observation',observedLcl:lcl,observedLclHash:hp.lclHash,nonce:lcl,validatedIndex:vi,ledgerHash:hash,tenantSequence:tseq,signerListHash:'S',submittedTx:modes.has('collude')?[{ref:'C',hash:'COLLUDETX',lastLedgerSequence:lcl+30,resultCode:'tesSUCCESS'}]:mySubmits})}));}
 process.send({done:id,err,aborted,voteUsed,f:['operations.json','cluster.json','acquires.json'].map(f=>fs.existsSync(f)?fs.readFileSync(f,'utf8'):'')});})();
