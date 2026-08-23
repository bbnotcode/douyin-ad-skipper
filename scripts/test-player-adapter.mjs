import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../player-adapter.js',import.meta.url),'utf8');
const context={URLSearchParams};
vm.createContext(context);
vm.runInContext(source,context);
const adapter=context.DouyinSegmentAdapter;

assert.equal(adapter.idFromLocation('/video/7669344658548047311',''),'7669344658548047311');
assert.equal(adapter.idFromLocation('/recommend','?modal_id=7669344658548047312'),'7669344658548047312');
assert.equal(adapter.idFromLocation('/recommend','?modal_id=bad'),null);

function fakeNode({attrs={},className='',parent=null,hosts={}}={}){
  return {className,parentElement:parent,getAttribute:(name)=>attrs[name]||null,querySelector:(selector)=>hosts[selector]||null};
}
const card=fakeNode({attrs:{'data-aweme-id':'7669344658548047313'}});
const video=fakeNode({parent:card});
assert.equal(adapter.idFromNode(video),'7669344658548047313');

const legacyHost={name:'legacy'};
const legacyPlayer=fakeNode({hosts:{'.xgplayer-controls-right':legacyHost}});
const legacyVideo=fakeNode({parent:legacyPlayer});
assert.equal(adapter.findControlsHost(legacyVideo)?.host,legacyHost);
assert.equal(adapter.findControlsHost(legacyVideo)?.strategy,'.xgplayer-controls-right');

const nextHost={name:'next'};
const nextPlayer=fakeNode({hosts:{'[class*="controls-right"]':nextHost}});
const nextVideo=fakeNode({parent:nextPlayer});
assert.equal(adapter.findControlsHost(nextVideo)?.host,nextHost);
assert.notEqual(adapter.findControlsHost(legacyVideo)?.host,adapter.findControlsHost(nextVideo)?.host);

console.log('播放器适配回归测试通过');
