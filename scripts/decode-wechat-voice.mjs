// Local codec only. No model, network, account data or plugin code is loaded.
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const MAX_BYTES=2*1024*1024,MAX_PCM_BYTES=16000*2*60.5;
const fault=code=>new Error(code);

export function validateSilk(bytes){
  if(bytes.length>MAX_BYTES)throw fault('VOICE_DECODE_LIMIT');
  const start=bytes[0]===2?1:0;
  if(bytes.toString('ascii',start,start+9)!=='#!SILK_V3')throw fault('VOICE_FORMAT_UNSUPPORTED');
  let offset=start+9,frames=0,end=bytes.length;
  while(offset<bytes.length){
    if(offset+2>bytes.length)throw fault('VOICE_FORMAT_UNSUPPORTED');
    const size=bytes.readUInt16LE(offset);offset+=2;
    if(size===65535&&offset===bytes.length){end=offset-2;break;}
    if(size===0||offset+size>bytes.length)throw fault('VOICE_FORMAT_UNSUPPORTED');
    offset+=size;
    if(++frames>3025)throw fault('VOICE_DECODE_LIMIT');
  }
  if(!frames)throw fault('VOICE_FORMAT_UNSUPPORTED');
  return {start,end};
}

export function pcmWav(pcm){
  if(!pcm.length||pcm.length%2||pcm.length>MAX_PCM_BYTES)throw fault('VOICE_DECODE_LIMIT');
  const header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

async function codec(){
  try{return await import('../packages/voice-codec/silk-wasm/lib/index.mjs');}
  catch{throw fault('VOICE_DECODER_MISSING');}
}

export function voicePcm(wav){
  const invalid=()=>Object.assign(fault('VOICE_INVALID_WAV'),{code:'VOICE_INVALID_WAV',status:400});
  if(wav.length<44||wav.length>MAX_BYTES||wav.toString('ascii',0,4)!=='RIFF'||
    wav.readUInt32LE(4)!==wav.length-8||wav.toString('ascii',8,12)!=='WAVE')throw invalid();
  let format,pcm,offset=12;
  while(offset+8<=wav.length){
    const kind=wav.toString('ascii',offset,offset+4);
    const size=wav.readUInt32LE(offset+4);
    const end=offset+8+size;
    if(end+(size%2)>wav.length)throw invalid();
    if(kind==='fmt '){
      if(format||size<16)throw invalid();
      format=wav.subarray(offset+8,end);
    }
    if(kind==='data'){
      if(pcm)throw invalid();
      pcm=wav.subarray(offset+8,end);
    }
    offset=end+(size%2);
  }
  if(offset!==wav.length||!format||format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||
    format.readUInt32LE(4)!==16000||format.readUInt32LE(8)!==32000||format.readUInt16LE(12)!==2||
    format.readUInt16LE(14)!==16||!pcm?.length||pcm.length%2||pcm.length>32000*60)throw invalid();
  return pcm;
}

export async function encodeVoice(wav){
  const pcm=voicePcm(wav);
  const {encode}=await codec();
  const encoded=await encode(pcm,16000);
  const silk=Buffer.from(encoded.data);
  validateSilk(silk);
  return {silk,durationMs:encoded.duration};
}

export async function decodeVoice(bytes){
  const {start,end}=validateSilk(bytes);
  const {decode}=await codec();
  const framed=Buffer.concat([Buffer.from([2]),bytes.subarray(start,end)]);
  const result=await decode(framed,16000),pcm=Buffer.from(result.data),wav=pcmWav(pcm);
  return {b64:wav.toString('base64'),durationSeconds:Math.min(pcm.length/32000,60),sampleRate:16000};
}

export async function probeDecoder(){
  const {encode,decode}=await codec();
  const encoded=await encode(Buffer.alloc(1280),16000),decoded=await decode(encoded.data,16000);
  pcmWav(Buffer.from(decoded.data));
  return {decoder:true,backend:'silk-wasm',sampleRate:16000};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    let result;
    if(process.argv[2]==='--probe')result=await probeDecoder();
    else{
      const chunks=[];let size=0;
      for await(const chunk of process.stdin){size+=chunk.length;if(size>3*1024*1024)throw fault('VOICE_DECODE_LIMIT');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(typeof value.b64!=='string'||!value.b64.length||value.b64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.b64))throw fault('VOICE_FORMAT_UNSUPPORTED');
      result=await decodeVoice(Buffer.from(value.b64,'base64'));
    }
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){
    const code=/^VOICE_[A-Z_]{3,80}$/.test(error.message??'')?error.message:'VOICE_DECODE_FAILED';
    process.stderr.write(JSON.stringify({error:code})+'\n');process.exitCode=1;
  }
}
