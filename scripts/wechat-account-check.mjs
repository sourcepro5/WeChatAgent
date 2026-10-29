import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readerAccountDirectory} from './reader-account-state.mjs';
import {hookProfile} from './hook-profiles.mjs';

const failure=code=>Object.assign(new Error(code),{code});
const transient=new Set(['HOOK_NOT_LISTENING','HOOK_HEALTH_TIMEOUT','HOOK_HEALTH_FAILED','HOOK_LOGIN_REQUIRED','HOOK_INITIALIZATION_PENDING']);

// Use the same conservative account gate before committing reader credentials
// and before native delivery. Never accept a target merely present among others.
export function hookAccountProblem(health,expectedAccount,expectedVersion='4.1.10.27') {
  if(typeof expectedAccount!=='string'||!expectedAccount)return 'HOOK_ACCOUNT_METADATA_INVALID';
  if(!health||typeof health!=='object')return 'HOOK_HEALTH_INVALID_RESPONSE';
  if(health.integration!=='WeChatAgent-1'||health.backend!=='wechat-hook')return 'REVIEWED_HOOK_BUILD_REQUIRED';
  if(health.version!==expectedVersion||!hookProfile(health.version))return 'HOOK_VERSION_MISMATCH';
  if(expectedVersion==='4.1.15.13'&&(health.profile!=='4.1.15.13-text-v1'||health.nativeTextSend!==true))return 'HOOK_INITIALIZATION_PENDING';
  if(health.startupState!==undefined&&health.startupState!=='ready')return 'HOOK_INITIALIZATION_PENDING';
  if(!Array.isArray(health.databaseAccounts)||health.databaseAccounts.some(account=>typeof account!=='string'||!account))return 'HOOK_ACCOUNT_METADATA_INVALID';
  if(!health.databaseAccounts.length)return 'HOOK_LOGIN_REQUIRED';
  if(health.databaseAccounts.length!==1)return 'HOOK_MULTIPLE_ACCOUNT_DATABASES';
  return health.databaseAccounts[0].toLowerCase()===expectedAccount.toLowerCase()?'':'HOOK_ACCOUNT_MISMATCH';
}

export async function verifyWeChatAccount({root,config,settings,fetchImpl=fetch,wait=true,requireReady=true,timeoutMs=30000,intervalMs=300,requestTimeoutMs=1500,onProgress=()=>{},now=Date.now,sleep=delay}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<0||timeoutMs>60000||!Number.isFinite(intervalMs)||intervalMs<1)throw failure('READER_ACCOUNT_STATE_INVALID');
  const directory=readerAccountDirectory(root,settings);
  if(!directory)throw failure('READER_PATH_MISSING');
  const expected=path.basename(directory).toLowerCase(),url=new URL(config.hook.baseUrl);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw failure('HOOK_LOOPBACK_REQUIRED');
  let token;try{token=fs.readFileSync(path.join(root,'state/hook/native-token.txt'),'utf8').trim();}catch{throw failure('HOOK_TOKEN_MISSING');}
  if(!/^[a-f0-9]{64}$/.test(token))throw failure('HOOK_TOKEN_MISSING');
  const deadline=now()+timeoutMs;let notified=false;
  for(;;){
    let health,code;
    try{
      const response=await fetchImpl(new URL('/WeChatAgent/health',url).href,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(requestTimeoutMs,wait?Math.max(1,deadline-now()):requestTimeoutMs)))});
      if(response.status===401)code='HOOK_AUTH_FAILED';
      else if(!response.ok)code='HOOK_HEALTH_FAILED';
      else{try{health=await response.json();code=hookAccountProblem(health,expected,config.hook.expectedVersion);}catch(error){if(error instanceof SyntaxError)code='HOOK_HEALTH_INVALID_RESPONSE';else throw error;}}
    }catch(error){
      const system=error.cause?.code??error.code;
      code=system==='ECONNREFUSED'?'HOOK_NOT_LISTENING':['TimeoutError','AbortError'].includes(error.name)||['ETIMEDOUT','ABORT_ERR','UND_ERR_CONNECT_TIMEOUT'].includes(system)?'HOOK_HEALTH_TIMEOUT':'HOOK_HEALTH_FAILED';
    }
    if(!code)return {ready:true,pid:health.pid};
    if(!transient.has(code))throw failure(code);
    if(!wait){if(!requireReady&&['HOOK_LOGIN_REQUIRED','HOOK_INITIALIZATION_PENDING'].includes(code))return {ready:false,code};throw failure(code);}
    if(now()>=deadline)throw failure(code==='HOOK_INITIALIZATION_PENDING'?'HOOK_INITIALIZATION_TIMEOUT':code);
    if(!notified){onProgress('正在核对实时微信账号。请在匹配微信中登录所选账号并等待消息同步…');notified=true;}
    await sleep(Math.min(intervalMs,Math.max(1,deadline-now())));
  }
}
