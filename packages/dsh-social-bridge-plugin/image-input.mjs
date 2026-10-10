import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function imageBlocks(ctx,root,conversationKey,images,provider,model) {
  if (!Array.isArray(images) || images.length>4) throw new Error('IMAGE_BATCH_LIMIT');
  if (!images.length) return [];
  if (images.some(image=>!/^[a-f0-9]{64}$/.test(image?.id ?? ''))) throw new Error('INVALID_IMAGE_REFERENCE');
  const llm=ctx.get('llm'), attachments=ctx.get('attachments');
  if (!llm || !attachments) throw new Error('NATIVE_IMAGE_SERVICES_UNAVAILABLE');
  const signal=AbortSignal.timeout(75000);
  const info=await llm.resolveModelInfo(provider,model,signal);
  if (!info.inputModalities?.includes('image')) throw new Error('MODEL_IMAGE_INPUT_UNSUPPORTED');
  const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,''));
  const base=new URL(io.reader_base_url);
  if (base.protocol!=='http:' || base.hostname!=='127.0.0.1' || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('IMAGE_READER_LOOPBACK_REQUIRED');
  const blocks=[];
  for (const image of images) {
    const response=await fetch(base.origin+'/api/v1/images/'+image.id,{headers:{Authorization:'Bearer '+io.reader_token},redirect:'error',signal});
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = new Error('IMAGE_READER_NOT_READY');
      if (typeof failure.error === 'string' && /^IMAGE_[A-Z_]{3,80}$/.test(failure.error)) error.imageError = failure.error;
      throw error;
    }
    const content=await response.json();
    if (content.imageId!==image.id || content.conversationKey!==conversationKey) throw new Error('IMAGE_CONVERSATION_MISMATCH');
    if (typeof content.b64!=='string' || content.b64.length>1100000 || !['image/png','image/jpeg','image/webp'].includes(content.mime)) throw new Error('INVALID_IMAGE_DATA');
    const data=Buffer.from(content.b64,'base64');
    if (!data.length || data.length>768*1024 || data.toString('base64')!==content.b64 || crypto.createHash('sha256').update(data).digest('hex')!==content.sha256) throw new Error('IMAGE_INTEGRITY_FAILED');
    const attachment=await attachments.saveImage({data,mediaType:content.mime,name:'wechat-image-'+image.id.slice(0,12)});
    blocks.push({type:'image',attachment});
  }
  return blocks;
}

export function offloadCompletedImages(session,sourceSeqs) {
  const targets=[];
  for (const seq of sourceSeqs) {
    const event=session.eventAt(seq);
    const message=session.deriveEventMessage ? session.deriveEventMessage(event) : event.data;
    const imageIndexes=[];let index=0;
    for (const block of message.content ?? []) if(block.type==='image'){if(!block.offloaded)imageIndexes.push(index);index++;}
    if (imageIndexes.length) targets.push({seq,imageIndexes});
  }
  if(targets.length) session.append('image/offload',{targets});
}

export function offloadCompletedSessionImages(session) {
  const completed=session.snapshotEvents().findLast(event=>event.type==='turn/end' && event.data.reason?.kind==='completed');
  if(!completed)return;
  const seqs=session.surface.nodes.filter(seq=>{
    const event=session.eventAt(seq);
    return seq<completed.seq && event.type==='user/message' && event.data.source?.socialImageIds?.length;
  });
  offloadCompletedImages(session,seqs);
}
