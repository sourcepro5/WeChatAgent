import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {personaError} from '../public/console/persona-files.mjs';

const fail=(message,status=400)=>Object.assign(Error(message),{status});
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const categoryId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const normalized=value=>value.normalize('NFKC').toLocaleLowerCase();
function title(value){
  if(typeof value!=='string'||!value.trim()||value.trim().length>60||/[\u0000-\u001f\u007f]/.test(value))throw fail('分类名称需为 1–60 个字符，不能包含换行或控制字符。');
  value=value.trim();
  if(['全部','未分类'].includes(value.normalize('NFKC')))throw fail('“全部”和“未分类”是系统分类，请使用其他名称。');
  return value;
}

export function createPersonaCategories(root){
  const file=path.join(root,'state','persona-categories.json');
  const names=()=>fs.existsSync(path.join(root,'roles'))?fs.readdirSync(path.join(root,'roles'),{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.md')&&!personaError(entry.name.slice(0,-3),'check')).map(entry=>entry.name.slice(0,-3)):[];
  function load(){
    if(!fs.existsSync(file))return {raw:'',value:{version:1,categories:[],assignments:{}}};
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw fail('人格分类文件不可读取，请检查 state/persona-categories.json，原数据已保留。',409);
    const raw=fs.readFileSync(file,'utf8');let value;
    try{
      value=JSON.parse(raw);
      if(value.version!==1||!Array.isArray(value.categories)||value.categories.length>100||!value.assignments||typeof value.assignments!=='object'||Array.isArray(value.assignments)||Object.keys(value.assignments).length>10000)throw Error();
      const ids=new Set(),titles=new Set();
      for(const group of value.categories){if(!categoryId(group.id)||ids.has(group.id)||title(group.title)!==group.title||titles.has(normalized(group.title)))throw Error();ids.add(group.id);titles.add(normalized(group.title));}
      const roles=new Set();
      for(const [name,id] of Object.entries(value.assignments)){if(personaError(name,'check')||!ids.has(id)||roles.has(name.toLocaleLowerCase()))throw Error();roles.add(name.toLocaleLowerCase());}
    }catch{throw fail('人格分类文件格式有误，请检查 state/persona-categories.json，原数据已保留。',409);}
    return {raw,value};
  }
  function view(loaded=load()){
    const current=new Map(names().map(name=>[name.toLocaleLowerCase(),name]));
    const assignments=Object.fromEntries(Object.entries(loaded.value.assignments).filter(([name])=>current.has(name.toLocaleLowerCase())).map(([name,id])=>[current.get(name.toLocaleLowerCase()),id]));
    return {version:1,revision:digest(loaded.raw),categories:loaded.value.categories,assignments};
  }
  function write(value){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  function update(body){
    const loaded=load(),current=view(loaded);
    if(body.revision!==current.revision)throw fail('人格分类已被修改，请刷新分类后重试。',409);
    const value={version:1,categories:current.categories.map(group=>({...group})),assignments:{...current.assignments}};
    const group=value.categories.find(item=>item.id===body.categoryId);
    if(body.action==='create'||body.action==='rename'){
      const label=title(body.title);
      if(value.categories.some(item=>(body.action==='create'||item!==group)&&normalized(item.title)===normalized(label)))throw fail('已有同名分类，请使用其他名称。',409);
      if(body.action==='create'){
        if(value.categories.length>=100)throw fail('最多可创建 100 个分类。');
        value.categories.push({id:crypto.randomBytes(16).toString('hex'),title:label});
      }else{if(!group)throw fail('分类已不存在，请刷新后重试。',409);group.title=label;}
    }else if(body.action==='delete'){
      if(!group)throw fail('分类已不存在，请刷新后重试。',409);
      if(body.confirmed!==true)throw fail('请先确认删除分类；分类中的人格会保留并移入“未分类”。',409);
      value.categories=value.categories.filter(item=>item!==group);
      value.assignments=Object.fromEntries(Object.entries(value.assignments).filter(([,id])=>id!==group.id));
    }else if(body.action==='assign'){
      if(personaError(body.name,'check'))throw fail('请选择有效的人格。');
      const name=names().find(name=>name.toLocaleLowerCase()===body.name.toLocaleLowerCase());
      if(!name)throw fail('人格已不存在，请刷新后重试。',404);
      if(body.categoryId!==''&&!group)throw fail('分类已不存在，请刷新后重试。',409);
      if(body.categoryId==='')delete value.assignments[name];else Object.defineProperty(value.assignments,name,{value:group.id,enumerable:true,configurable:true,writable:true});
    }else throw fail('不支持的分类操作。');
    write(value);return view();
  }
  function forget(name){
    const loaded=load();
    if(!Object.keys(loaded.value.assignments).some(key=>key.toLocaleLowerCase()===name.toLocaleLowerCase()))return ()=>{};
    const value={...loaded.value,assignments:Object.fromEntries(Object.entries(loaded.value.assignments).filter(([key])=>key.toLocaleLowerCase()!==name.toLocaleLowerCase()))};
    write(value);return ()=>write(loaded.value);
  }
  return {read:view,update,forget};
}
