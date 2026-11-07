import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {consoleRoute,routeKey,MAIN_PAGES,featureLocation,chatRows,filterChats,effectiveChatFeature} from '../public/console/layout-model.mjs';
import {createWorkspaceLayout} from '../public/console/workspace-layout.js';
const key='wechat:private:123',group='wechat:group:456';
const config=()=>({wechat:{whitelist:{private:['123'],groups:['456']},workModes:{[key]:'assistant'},search:{enabled:false,chats:{[key]:true}},stickers:{enabled:true,chats:{}},proactive:{enabled:false,chats:{[group]:true}},context:{enabled:true,maxTokens:100000,chats:{[group]:0}},assistant:{fileTransferChats:{[key]:true}},dshAccess:{chats:{[key]:{mode:'native',preset:'standard',skills:['saved'],tools:['read'],remoteApproval:true}}}},persona:{default:'默认人格',chats:{[key]:'助手人格'}}});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture({offline=false,tab='summary',historyMode,running=false,workMode='assistant'}={}){
 const original=config(),state={config:original,draft:structuredClone(original),names:new Map([[key,'同名 <好友>'],[group,'同名 <好友>']]),chatKind:'all',chatDetailTab:tab,selectedChat:key},requests=[];
 const api=async(route,body)=>{requests.push({route,body});if(offline)throw Error('offline fixture');if(route==='/api/sessions')return {sessions:[{conversationKey:key,sessionId:'native-123',workMode,contextTokens:5200,running,...(historyMode?{history:{mode:historyMode},prefixRepairAvailable:historyMode==='recent-window-v1'&&workMode==='social',prefixRecovery:{status:'required'}}:{})},{conversationKey:group,sessionId:'native-456',contextTokens:8100}]};if(route==='/api/session-groups')return {available:true,groups:[],assignments:{}};if(route==='/api/assistant-task/list')return {tasks:[{id:'T0123456789abcdef',state:'waiting_approval',stage:'等待审批',createdAt:100000}]};throw Error('Unexpected request '+route);};
 const ui=createWorkspaceLayout({api,state,escapeHtml:esc,icon:()=>'',header:(title,help='')=>'<h2>'+esc(title)+'</h2><p>'+esc(help)+'</p>',field:()=>'',toggle:()=>'',empty:(title,help,actions)=>'<h2>'+esc(title)+'</h2><p>'+esc(help)+'</p>'+(actions??''),sessionGroupUI:{prepare(){},visible:()=>true,toolbar:()=>'',control:()=>'',isAvailable:()=>true,unavailableMessage:()=>''},sessionUsage:()=>'<div>Fixture usage</div>',getCards:()=>({participation:'PARTICIPATION',rhythm:'RHYTHM',proactive:'PROACTIVE',admins:'ADMINS',search:'SEARCH',reader:'READER',media:'MEDIA'}),contextSettingsCard:()=> 'CONTEXT',feedbackCard:()=> 'FEEDBACK',connectionsPage:()=> 'CONNECTIONS',logsPage:async()=> 'LOGS',toolsPage:()=> 'TOOLS',dshPage:async()=> 'DSH',stickerPage:async()=> 'STICKERS'});
 return {state,ui,requests};
}
test('main entries preserve legacy links and isolate memory subpage routes',()=>{
 assert.deepEqual(MAIN_PAGES,['overview','chats','roles','extensions','stickers','memory','settings']);
 assert.deepEqual(consoleRoute('#sessions'),{page:'chats',detail:'usage'});assert.deepEqual(consoleRoute('#behavior'),{page:'settings',section:'chat'});assert.equal(routeKey(consoleRoute('#connections')),'settings/connections');assert.equal(routeKey(consoleRoute('#tools')),'settings/diagnostics');assert.equal(routeKey(consoleRoute('#logs')),'settings/logs');
 assert.equal(routeKey(consoleRoute('#settings/assistant')),'settings/assistant');assert.equal(routeKey(consoleRoute('#stickers/sources')),'stickers/sources');assert.equal(routeKey(consoleRoute('#extensions/network')),'extensions/network');assert.equal(consoleRoute('#settings/unknown').section,'chat');assert.equal(consoleRoute('#not-a-page').page,'overview');
 const html=fs.readFileSync('public/console/index.html','utf8'),entries=[...html.matchAll(/data-page="([^"]+)"/g)].map(match=>match[1]).filter(id=>id!=='setup');assert.deepEqual(entries,MAIN_PAGES);
});
test('feature links lead to one canonical configuration without changing permission policy',()=>{
 assert.equal(featureLocation('native-search'),'#extensions/network');assert.equal(featureLocation('native-web-reader'),'#extensions/network');assert.equal(featureLocation('dsh-meme'),'#stickers/sources');assert.equal(featureLocation('native-stickers'),'#stickers/sending');assert.equal(featureLocation('native-proactive'),'#settings/chat');assert.equal(featureLocation('native-context'),'#settings/context');assert.equal(featureLocation('native-member-memory'),null);assert.equal(featureLocation('third-party'),null);
});
test('displayed effective state preserves default overrides and master-switch semantics',()=>{
 const c=config(),before=JSON.stringify(c);assert.deepEqual(effectiveChatFeature(c,key,'search'),{enabled:true,source:'本聊天单独设置'});assert.deepEqual(effectiveChatFeature(c,group,'search'),{enabled:false,source:'继承账号默认'});assert.deepEqual(effectiveChatFeature(c,group,'proactive'),{enabled:false,source:'总开关关闭'});assert.deepEqual(effectiveChatFeature(c,group,'context'),{enabled:false,source:'本聊天关闭'});assert.equal(effectiveChatFeature(c,key,'stickers').enabled,true);assert.equal(JSON.stringify(c),before);
});
test('one chat list retains identities across same names, modes, sessions and filters',()=>{
 const c=config(),sessions=[{conversationKey:key,sessionId:'first'},{conversationKey:group,sessionId:'second'}],rows=chatRows(c,new Map([[key,'同名'],[group,'同名']]),sessions);assert.equal(rows.length,2);assert.equal(rows[0].session.sessionId,'first');assert.equal(rows[1].session.sessionId,'second');assert.equal(filterChats(rows,{kind:'groups'})[0].key,group);assert.equal(filterChats(rows,{mode:'assistant'})[0].key,key);assert.equal(filterChats(rows,{query:'456'})[0].key,group);assert.equal(filterChats(rows,{query:'默认人格'})[0].key,group);assert.equal(filterChats(rows,{query:'同名'}).length,2);
});
test('merged chat rendering is read-only, escaped and retains one settings entry for the selected chat',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft),html=await f.ui.chatsPage();assert.match(html,/同名 &lt;好友&gt;/);assert(!html.includes('同名 <好友>'));assert.equal([...html.matchAll(/data-chat-settings=/g)].length,1);assert.equal([...html.matchAll(/data-chat-select=/g)].length,2);assert(!html.includes('data-dsh-chat'));assert.match(html,/本聊天单独设置/);assert.equal(JSON.stringify(f.state.draft),before);assert(f.requests.every(item=>item.body===undefined));
});
test('offline DSH leaves contact settings available and never invents a session',async()=>{
 const f=fixture({offline:true}),before=JSON.stringify(f.state.config),html=await f.ui.chatsPage();assert.equal([...html.matchAll(/data-chat-select=/g)].length,2);assert.match(html,/任务与用量暂不可用/);assert.match(html,/初始化此聊天/);assert(!html.includes('native-123'));assert.equal(JSON.stringify(f.state.config),before);
});

test('memory shortcuts keep the selected saved chat and do not expose unsaved group drafts',async()=>{
 const f=fixture();f.state.selectedChat=group;let html=await f.ui.chatsPage();assert(html.includes('data-memory-open="'+group+'"'));assert(html.includes('data-memory-section="members"'));
 f.state.draft.wechat.whitelist.groups.push('789');f.state.selectedChat='wechat:group:789';html=await f.ui.chatsPage();assert(!html.includes('data-memory-open='));
 f.state.selectedChat=key;f.state.chatDetailTab='usage';html=await f.ui.chatsPage();assert(html.includes('data-memory-open="'+key+'"'));assert(html.includes('data-memory-section="summaries"'));
});
test('task controls bind the actual task ID and file scope without running or cancelling work',async()=>{
 const f=fixture({tab:'tasks'}),before=JSON.stringify(f.state.draft),html=await f.ui.chatsPage();assert.match(html,/data-assistant-task-id="T0123456789abcdef"/);assert.match(html,/data-assistant-cancel="wechat:private:123"/);assert.match(html,/50 MB/);assert.equal(JSON.stringify(f.state.draft),before);assert.deepEqual(f.requests.filter(item=>item.body!==undefined),[{route:'/api/assistant-task/list',body:{key}}]);
 f.state.selectedChat=group;const social=await f.ui.chatsPage();assert.match(social,/聊天模式不执行助手任务/);assert(!social.includes('data-assistant-cancel='));
});
test('settings and network sections render only their own controls while drafts and native grants survive',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft);f.state.settingsSection='assistant';const assistant=await f.ui.settingsPage();assert.match(assistant,/ADMINSFEEDBACK/);assert(!assistant.includes('PARTICIPATION'));f.state.settingsSection='context';const context=await f.ui.settingsPage();assert.match(context,/CONTEXT/);assert(!context.includes('ADMINS'));const network=f.ui.networkPage();assert.match(network,/SEARCHREADER/);assert(!network.includes('MEDIA'));assert.equal(JSON.stringify(f.state.draft),before);assert.equal(f.state.draft.wechat.dshAccess.chats[key].preset,'standard');assert.deepEqual(f.state.draft.wechat.dshAccess.chats[key].tools,['read']);
});
test('sticker collection, sources and sending retain separate original settings scopes',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft);f.state.stickerSection='sources';const sources=await f.ui.stickersPage();assert.match(sources,/data-extension-details="dsh-meme"/);assert.match(sources,/MEDIA/);f.state.stickerSection='library';assert.match(await f.ui.stickersPage(),/STICKERS/);assert.equal(JSON.stringify(f.state.draft),before);
});


test('window context repair is visible only for social windows, is disabled while busy and rendering never repairs',async()=>{
 const f=fixture({tab:'usage',historyMode:'recent-window-v1',workMode:'social'});f.state.config.wechat.workModes[key]='social';f.state.draft.wechat.workModes[key]='social';
 const html=await f.ui.chatsPage();assert(html.includes('data-context-repair="'+key+'"'));assert(html.includes('data-context-session="native-123"'));assert(html.includes('人格前缀校验未通过'));assert(f.requests.every(item=>item.body===undefined));
 const busy=fixture({tab:'usage',historyMode:'recent-window-v1',running:true,workMode:'social'});busy.state.config.wechat.workModes[key]='social';busy.state.draft.wechat.workModes[key]='social';
 assert.match(await busy.ui.chatsPage(),/data-context-session="native-123" disabled/);
 assert(!(await fixture({tab:'usage',historyMode:'recent-window-v1'}).ui.chatsPage()).includes('data-context-repair'));
 const bounded=fixture({tab:'usage',historyMode:'external-bounded-v1',workMode:'social'});bounded.state.draft.wechat.workModes[key]='social';assert(!(await bounded.ui.chatsPage()).includes('data-context-repair'));
});
test('usage tab shows current context against the compaction threshold as a meter',async()=>{
 const f=fixture({tab:'usage'});f.state.draft.wechat.context={...f.state.draft.wechat.context,maxTokens:100000,chats:{}};
 const html=await f.ui.chatsPage();
 assert.match(html,/<div class="usage-stat"><span>当前上下文<\/span><strong>5,200 token<\/strong><small>压缩阈值 100,000 token<\/small>/);
 assert.match(html,/<progress class="usage-meter" max="100000" value="5200"/);
 const off=fixture({tab:'usage'});off.state.draft.wechat.context={...off.state.draft.wechat.context,maxTokens:100000,chats:{[off.state.selectedChat]:0}};
 const offHtml=await off.ui.chatsPage();
 assert.match(offHtml,/此聊天已关闭自动压缩/);
 assert(!offHtml.includes('usage-meter'));
});
