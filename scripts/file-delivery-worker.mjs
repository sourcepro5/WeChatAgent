import {FileTransfers} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
const terminal=new Set(['confirmed','failed','unconfirmed','cancelled','expired']);
const rowKey=row=>JSON.stringify([row.localId,row.serverId,row.createTime]);
const safeError=error=>/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code??error?.message)?error.code??error.message:'FILE_DELIVERY_FAILED';
export class FileDeliveryWorker {
  constructor(adapter,{log=()=>{},pollMs=1000}={}){this.adapter=adapter;this.store=new FileTransfers(adapter.directory);this.log=log;this.pollMs=pollMs;this.running=new Set();this.targets=new Set();this.stopped=false;}
  save(job){this.store.write(job);this.log('[File] '+job.id.slice(0,12)+' state='+job.state+(job.error?' code='+job.error:''));}
  tick(){if(this.stopped||this.running.size>=2||this.adapter.status.backend==='wechat-input'&&this.adapter.status.paused)return;for(const job of this.store.list().sort((a,b)=>a.createdAt-b.createdAt)){
    if(terminal.has(job.state)||this.running.has(job.id)||this.targets.has(job.key)||this.running.size>=2)continue;
    this.running.add(job.id);this.targets.add(job.key);void this.run(job).catch(error=>{if(job.state==='queued'&&(error.code??error.message)==='INPUT_PAUSED')return;job.state=job.state==='queued'?'failed':'unconfirmed';job.error=safeError(error);try{this.save(job);}catch{}}).finally(()=>{this.running.delete(job.id);this.targets.delete(job.key);});
  }}
  async run(job){
    const adapter=this.adapter;
    if(job.accountScope!==this.store.account()||!this.store.allowed(job.key,job.sender)){job.state='cancelled';job.error='FILE_ACCESS_CHANGED';this.save(job);return;}
    if(Date.now()>=job.deadlineAt){job.state=job.state==='queued'?'expired':'unconfirmed';job.error='FILE_DELIVERY_TIMEOUT';this.save(job);return;}
    const [,kind,target]=job.key.split(':');if(!['private','group'].includes(kind)||!/^\d+$/.test(target))throw Error('FILE_JOB_INVALID');
    const identity=await adapter.checkNative();if(adapter.status.backend==='wechat-input'&&adapter.status.paused)throw Error('INPUT_PAUSED');if((adapter.status.file_send??adapter.status.native_file_send)!==true)throw Error('FILE_NATIVE_SENDER_NOT_READY');const wxid=await adapter.resolveTarget(kind,target);
    if(job.wxid&&job.wxid!==wxid||job.account&&job.account!==identity.account)throw Error('FILE_ACCOUNT_CHANGED');
    if(job.state==='queued'){
      const source=this.store.staged(job),proof=await this.store.hash(source,AbortSignal.timeout(10000));if(proof.sha256!==job.sha256||proof.md5!==job.md5||proof.size!==job.size)throw Error('FILE_STAGED_INVALID');
      job.wxid=wxid;job.account=identity.account;job.baseline=(await adapter.messages(wxid)).map(rowKey);job.startedAt=Date.now();
      if(this.stopped||!this.store.allowed(job.key,job.sender)||job.accountScope!==this.store.account()){job.state='cancelled';job.error='FILE_ACCESS_CHANGED';this.save(job);return;}
      job.state='submitting';this.save(job); // Persist BEFORE native submission.
      try{const result=await adapter.native('/SendFileMsg',{wxidorgid:wxid,path:source,md5:job.md5,size:job.size},identity.account);if(result?.ret!==0){job.state='failed';job.error='FILE_NATIVE_REJECTED';this.save(job);return;}}
      catch(error){
        // An explicit pre-submission 429 can be retried a bounded number of
        // times. Network failures remain uncertain and are never resubmitted.
        if(error.message==='API_HTTP_429'&&(job.busyAttempts??0)<3){job.state='queued';job.busyAttempts=(job.busyAttempts??0)+1;delete job.startedAt;this.save(job);return;}
        if(/^API_HTTP_(400|401|403|409|429)$/.test(error.message)){job.state='failed';job.error=safeError(error);this.save(job);return;}
        job.error='FILE_SUBMISSION_UNCERTAIN';
      }
      job.state='submitted';this.save(job);
    }
    if(!Array.isArray(job.baseline)||job.baseline.length>500||!Number.isFinite(job.startedAt))throw Error('FILE_RECEIPT_STATE_INVALID');
    const baseline=new Set(job.baseline);
    // Receipt waits never hold the text/sticker sender's target lock.
    while(!this.stopped&&Date.now()<job.deadlineAt){
      if(!this.store.allowed(job.key,job.sender)||job.accountScope!==this.store.account()){job.state='unconfirmed';job.error='FILE_ACCESS_CHANGED_AFTER_SUBMISSION';this.save(job);return;}
      for(const row of await adapter.messages(wxid))if(row.isSend&&(row.localType===25769803825||row.localType===49&&row.fileKind==='appmsg-6')&&row.fileName===job.name&&row.fileSize===job.size&&(!row.fileMd5||row.fileMd5===job.md5)&&!baseline.has(rowKey(row))&&row.createTime>=Math.floor(job.startedAt/1000)-30&&/^\d+$/.test(String(row.serverId))&&BigInt(row.serverId)>0n){
        job.state='confirmed';job.receipt={messageId:String(row.localId),type:'wechat-file',serverConfirmed:true};delete job.error;this.save(job);adapter.status.confirmed_sends++;return;
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(this.pollMs,Math.max(1,job.deadlineAt-Date.now()))));
    }
    if(!this.stopped){job.state='unconfirmed';job.error='FILE_DELIVERY_TIMEOUT';this.save(job);}
  }
  stop(){this.stopped=true;}
}
