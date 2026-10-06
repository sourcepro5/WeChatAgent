"""Private, account-scoped descriptions of verified sticker resources."""
import json,pathlib,re,uuid,time

def clean_label(item):
    description=item.get('description') if isinstance(item,dict) else None
    tags=item.get('tags') if isinstance(item,dict) else None
    if not isinstance(description,str) or not description.strip() or len(description)>120 or re.search(r'[\x00-\x1f]',description):raise ValueError('Invalid sticker description')
    if not isinstance(tags,list) or len(tags)>6 or any(not isinstance(tag,str) or not tag.strip() or len(tag)>16 or re.search(r'[\x00-\x1f]',tag) for tag in tags):raise ValueError('Invalid sticker tags')
    return {'description':description.strip(),'tags':list(dict.fromkeys(tag.strip() for tag in tags))}

class StickerLabels:
    def __init__(self,file):
        self.file=pathlib.Path(file)
    def read(self):
        if not self.file.exists():return {'version':1,'accounts':{}}
        state=json.loads(self.file.read_text(encoding='utf-8-sig'))
        if state.get('version')!=1 or not isinstance(state.get('accounts'),dict):raise RuntimeError('STICKER_LABEL_CACHE_INVALID')
        return state
    def get(self,account,md5):
        item=self.read()['accounts'].get(account,{}).get(md5)
        if item is None:return None
        if item.get('labelVersion')!=1:return None
        return clean_label(item)
    def save(self,account,updates):
        state=self.read();entries=state['accounts'].setdefault(account,{})
        for md5,item in updates:
            if not re.fullmatch(r'[a-f0-9]{32}',md5):raise ValueError('Invalid source digest')
            entries[md5]={**clean_label(item),'labelVersion':1,'updatedAt':int(time.time())}
        if len(entries)>2000:
            keep=sorted(entries,key=lambda digest:entries[digest]['updatedAt'],reverse=True)[:2000]
            state['accounts'][account]={digest:entries[digest] for digest in keep}
        self.file.parent.mkdir(parents=True,exist_ok=True)
        temp=self.file.with_name(self.file.name+'.'+uuid.uuid4().hex+'.tmp')
        temp.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8');temp.replace(self.file)
