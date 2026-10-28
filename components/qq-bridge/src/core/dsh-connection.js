// A reconnect boundary acknowledges old inputs without deleting their history.
export class DshConnectionGuard {
  constructor({buffer,probe,now=Date.now,log=()=>{},pollMs=2000}) {
    Object.assign(this,{buffer,probe,now,log,pollMs});
    this.saved=buffer.dshConnection;this.ready=false;this.initialized=false;this.epoch=this.saved?.epoch??0;
    this.cutoff=this.saved?.cutoff??0;this.instanceId=this.saved?.instanceId??'';this.lastCheck=-Infinity;this.stopped=false;this.failures=0;
  }
  current(epoch){return !this.stopped&&this.ready&&epoch===this.epoch;}
  skips(message){return !this.ready||Number(message.timestamp)*1000<this.cutoff;}
  metadata(){return this.instanceId&&this.instanceId!=='legacy'?{dshInstanceId:this.instanceId}:{};}
  async check({force=false}={}) {
    if(this.stopped)return false;
    if(this.checking)return this.checking;
    if(!force&&this.now()-this.lastCheck<500)return this.ready;
    const requestedAt=this.now();
    this.checking=(async()=>{
      let health;try{health=await this.probe();}catch{health={ready:false};}
      if(this.stopped)return false;
      const healthy=health?.ready===true;
      if(this.ready&&!healthy&&++this.failures<3){
        this.lastCheck=this.now();
        return this.ready;
      }
      if(healthy)this.failures=0;
      const previous=this.initialized?this.buffer.dshConnection:this.saved;
      const online=healthy,id=online?(health.instanceId||'legacy'):(previous?.instanceId??'');
      const boundary=!this.initialized?(!previous||previous.ready!==online||online&&previous.instanceId!==id):this.ready!==online||online&&this.instanceId!==id;
      this.ready=online;this.initialized=true;this.lastCheck=this.now();
      if(boundary){
        this.epoch++;
        const started=Number(health?.startedAt);
        const newInstance=online&&previous&&previous.instanceId!==id;
        const resumedAt=newInstance&&Number.isFinite(started)&&started>0&&started<=this.now()+1000?Math.min(started,requestedAt):requestedAt;
        if(online)this.cutoff=Math.max(this.cutoff,Math.floor(resumedAt/1000)*1000);
        this.instanceId=id;
        this.buffer.dshConnection={version:1,ready:online,epoch:this.epoch,instanceId:id,cutoff:this.cutoff,changedAt:this.now()};
        // Initial migration and confirmed offline periods never replay old inputs.
        const skipped=this.buffer.skipOfflineInputs({reason:online?'dsh_reconnected':'dsh_offline'});
        this.onBoundary?.({online,epoch:this.epoch});
        this.buffer.saveMedia();
        this.log('[DSH] connection='+ (online?'ready':'offline')+' epoch='+this.epoch+' skipped='+skipped+' replay=disabled');
      }else if(!this.buffer.dshConnection){
        this.buffer.dshConnection={...previous};
      }
      return this.ready;
    })().catch(error=>{this.ready=false;this.log('[DSH] connection_state_failed code='+(error.code??'STATE_UNAVAILABLE'));return false;}).finally(()=>{this.checking=null;});
    return this.checking;
  }
  start(){if(!this.timer)this.timer=setInterval(()=>void this.check({force:true}),this.pollMs);this.timer?.unref?.();}
  stop(){this.stopped=true;this.ready=false;clearInterval(this.timer);}
}
