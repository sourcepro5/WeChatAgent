import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const git=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'});
if(git.status!==0)throw new Error('Cannot enumerate source candidates; run this check in the Git checkout');
const files=[...new Set(git.stdout.split('\0').filter(Boolean))];
const findings=[];let bytes=0;
const banned=/(^|\/)(state|release|node_modules|\.local-state|\.git|\.venv|venv)\/|(^|\/)wechatagent\.json$|wechatagent\.pre-|(^|\/)\.env(?:\.[^/]+)?$|\.(?:exe|dll|node|pdb|obj|lib|so|dylib|db|sqlite3?|pfx|pem|key|log|bak|pyc|zip|7z|rar)$/i;
const example=/\.env\.(?:example|sample|template)$/;
const checks=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['credential-url',/https?:\/\/[^\s/@:]+:[^\s/@]+@/],
 ['api-key',/\bsk-(?!example|placeholder|test)[A-Za-z0-9_-]{20,}\b/],
 ['developer-home',/[A-Z]:[\\/]Users[\\/](?!Public[\\/]|<|YOUR_)[^\s<>"']+[\\/]/i],
 ['developer-checkout',/[A-Z]:[\\/]Transfer[\\/]DeepSeek[\\/]/i]
];
for(const relative of files){
 const file=path.join(root,relative);if(!fs.existsSync(file))continue;
 if(banned.test(relative)&&!example.test(relative)){findings.push({file:relative,kind:'excluded-file'});continue;}
 const stat=fs.statSync(file);bytes+=stat.size;
 if(stat.size>100*1024*1024){findings.push({file:relative,kind:'github-file-limit'});continue;}
 const text=fs.readFileSync(file,'utf8');
 for(const [kind,regex] of checks){
  if(!regex.test(text))continue;
  findings.push({file:relative,kind});
 }
}
// Report names and categories only, never credential values or matching lines.
console.log(JSON.stringify({candidateFiles:files.length,sourceBytes:bytes,findings},null,2));
if(findings.length)process.exitCode=1;
