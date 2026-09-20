'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DeliveryOutbox}=require('../lib/delivery-outbox');
const ok2xx=(r,key)=>r&&r.$status>=200&&r.$status<300&&!r.error&&(!key||r[key]);
function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'roof-outbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'outbox.json');return {file,out:new DeliveryOutbox(file)};}
test('response lost after commit: restart retries identical key before ack, no new publication',async t=>{
  const {out,file}=fixture(t),posted=new Map(),seen=[],acks=[];
  out.prepare({route:'/say',body:{text:'result'},inboxIds:['m1'],exit:'say'});
  let lose=true;
  const api=async(method,route,body)=>{seen.push(body.client_request_id);posted.set(body.client_request_id,{id:'response',$status:200});if(lose){lose=false;throw new Error('response lost')}return posted.get(body.client_request_id)};
  const opts={api,ok2xx,acknowledge:async ids=>acks.push(ids)};
  await assert.rejects(out.flush(opts));assert.equal(acks.length,0);assert.equal(out.read().phase,'prepared');
  await new DeliveryOutbox(file).flush(opts);assert.equal(posted.size,1);assert.equal(new Set(seen).size,1);assert.deepEqual(acks,[['m1']]);assert.equal(out.read(),null);
});
test('ack failure after publication: restart retries ack only and retains unrelated inputs',async t=>{
  const {out,file}=fixture(t);let calls=0,fail=true;const ack=[];
  out.prepare({route:'/dm',body:{to:'A',text:'result'},inboxIds:['old'],exit:'dm'});
  const opts={ok2xx,api:async()=>{calls++;return {$status:200,id:'m2'}},acknowledge:async ids=>{ack.push(ids);if(fail)throw new Error('ack down')}};
  await assert.rejects(out.flush(opts));assert.equal(out.read().phase,'accepted');fail=false;
  await new DeliveryOutbox(file).flush(opts);assert.equal(calls,1);assert.deepEqual(ack,[['old'],['old']]);
});
test('500/429/malformed success retain draft; explicit validation rejection releases it without ack',async t=>{
  for(const status of [500,429,200,400,404,413]) {
    const {out}=fixture(t);out.prepare({route:'/say',body:{text:'x'},inboxIds:['m1'],exit:'say'});let acked=false;
    await assert.rejects(out.flush({ok2xx,api:async()=>({$status:status}),acknowledge:async()=>{acked=true}}));
    assert.equal(acked,false);assert.equal(!!out.read(),![400,404,413].includes(status));
  }
});
test('corrupt persisted state fails closed and cannot be overwritten by a new reply',t=>{
  const {out,file}=fixture(t);fs.writeFileSync(file,'{broken');assert.throws(()=>out.read());assert.throws(()=>out.prepare({route:'/say',body:{text:'new'}}));
});
