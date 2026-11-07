import fs from 'node:fs';
import path from 'node:path';
import {directory,atomicJson,ID} from './catalog.mjs';

// Latest real voice-input-v1 attempt, one file per handling plugin.
const folder='state/plugin-service-checks/voice-input';
const stages=new Set(['configuration','audio','api','host','complete']);
function normalized(value,generation){
  if(value?.version!==1||value.generation!==generation||typeof value.ok!=='boolean'||!Number.isFinite(value.at)||value.at<0||!stages.has(value.stage))return null;
  const code=value.ok?'VOICE_TRANSCRIBED':/^VOICE_[A-Z0-9_]{3,80}$/.test(value.code??'')?value.code:'VOICE_INPUT_FAILED';
  return {version:1,generation,ok:value.ok,at:value.at,code,stage:value.stage};
}
export function writeVoiceAttempt(root,id,result,generation){
  if(!ID.test(id??'')||typeof generation!=='string'||!generation||generation.length>200)return;
  const value=normalized({version:1,generation,ok:result.ok===true,code:result.code,stage:result.stage,at:Date.now()},generation);
  if(!value)return;
  const file=path.join(directory(root,folder),id+'.json');
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())return;
  atomicJson(file,value);
}
export function readVoiceAttempt(root,id,generation){
  if(!ID.test(id??''))return null;
  try{
    const file=path.join(root,folder,id+'.json'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return null;
    return normalized(JSON.parse(fs.readFileSync(file,'utf8')),generation);
  }catch{return null;}
}
