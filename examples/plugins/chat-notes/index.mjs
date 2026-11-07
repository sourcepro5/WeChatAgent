export function setup(api){
  api.registerTool({
    id:'notes',
    description:'用户明确要求记便签、查看便签或清空便签时使用。只操作当前聊天；清空必须有用户的明确要求。',
    parameters:{type:'object',properties:{action:{type:'string',enum:['add','list','clear']},text:{type:'string',maxLength:1000}},required:['action'],additionalProperties:false},
    async execute(ctx,args){
      const notes=await ctx.storage.get('notes')??[];
      if(args.action==='list')return {content:notes.length?JSON.stringify(notes):'当前聊天还没有便签。'};
      if(args.action==='clear'){await ctx.storage.delete('notes');return {content:'当前聊天的便签已清空。'};}
      if(!args.text?.trim())return {content:'请提供要记下的内容。',isError:true};
      notes.push({text:args.text.trim(),createdAt:new Date().toISOString()});
      await ctx.storage.set('notes',notes.slice(-ctx.config().maxNotes));
      return {content:'已在当前聊天记下这条便签：'+args.text.trim()};
    },
  });
  // Actions are only for the plugin's own page (ui/page.html); the model never sees them.
  api.registerAction({
    id:'list',
    description:'本机插件页面读取所选聊天的便签。',
    parameters:{type:'object',properties:{},additionalProperties:false},
    async execute(ctx){return {notes:await ctx.storage.get('notes')??[]};},
  });
  api.registerAction({
    id:'remove',
    description:'本机插件页面删除所选聊天的一条便签。',
    parameters:{type:'object',properties:{index:{type:'integer',minimum:0,maximum:49}},required:['index'],additionalProperties:false},
    async execute(ctx,args){
      const notes=await ctx.storage.get('notes')??[];
      notes.splice(args.index,1);
      await ctx.storage.set('notes',notes);
      return {notes};
    },
  });
}
