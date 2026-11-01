import test from 'node:test';
import assert from 'node:assert/strict';
import {hookProfile} from './hook-profiles.mjs';
import {hookAccountProblem} from './wechat-account-check.mjs';
const health={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.2.0.12',profile:'4.2.0.12-experimental-v1',startupState:'ready',nativeTextSend:true,databaseAccounts:['fixture-account']};
test('the experimental profile accepts only the exact tested build and preserves stable profiles',()=>{
 assert.equal(hookProfile('4.2.0.12').experimental,true);assert.equal(hookProfile('4.2.0.12').nativeText,true);assert.equal(hookProfile('4.2.0.12').nativeSticker,false);
 assert(hookProfile('4.1.15.13'));assert(hookProfile('4.1.10.27'));
 for(const value of ['4.2.0','4.2.0.13','4.2.1.12','constructor',null,{}])assert.equal(hookProfile(value),null);
});
test('experimental account readiness requires the measured component profile and native construction readiness',()=>{
 assert.equal(hookAccountProblem(health,'fixture-account','4.2.0.12'),'');
 for(const override of [{profile:'4.1.15.13-media-mentions-v2'},{profile:'unknown'},{profile:undefined},{nativeTextSend:false},{startupState:'starting'}])assert.equal(hookAccountProblem({...health,...override},'fixture-account','4.2.0.12'),'HOOK_INITIALIZATION_PENDING');
 assert.equal(hookAccountProblem({...health,version:'4.2.0.13'},'fixture-account','4.2.0.12'),'HOOK_VERSION_MISMATCH');
 assert.equal(hookAccountProblem(health,'fixture-account','4.1.15.13'),'HOOK_VERSION_MISMATCH');
});
test('experimental support preserves single-account identity and login boundaries',()=>{
 for(const [accounts,expected] of [[[],'HOOK_LOGIN_REQUIRED'],[['another-fixture'],'HOOK_ACCOUNT_MISMATCH'],[['fixture-account','another-fixture'],'HOOK_MULTIPLE_ACCOUNT_DATABASES'],[null,'HOOK_ACCOUNT_METADATA_INVALID']])assert.equal(hookAccountProblem({...health,databaseAccounts:accounts},'fixture-account','4.2.0.12'),expected);
});
