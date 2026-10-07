const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('public/app.js','utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function estResponses('),source.indexOf('function responseSummaryCard(')),context);
test('ON monitors estimate prompts times models',()=>assert.equal(context.estResponses({active:true,promptCount:10,models:['a','b','c']}),30));
test('OFF monitors contribute zero',()=>assert.equal(context.estResponses({active:false,promptCount:10,models:['a','b','c']}),0));
test('project totals include only ON monitors',()=>assert.equal(context.estResponsesTotal([{active:true,promptCount:10,models:['a','b','c']},{active:false,promptCount:20,models:['a']}]),30));
test('missing prompts or models contribute zero',()=>assert.equal(context.estResponses({active:true}),0));
test('shared period changes all monitor estimates without changing actual usage', () => {
  context.state = {responses:{used:363,byMonitor:{a:{weekly:60,monthly:280},b:{weekly:30,monthly:140}}}};
  const monitors=[{id:'a',active:true,promptCount:10,models:['x','y']},{id:'b',active:false,promptCount:5,models:['x','y']}];
  context.responsePeriod='daily'; assert.equal(context.estimateTotal(monitors),20);
  context.responsePeriod='weekly'; assert.equal(context.estimateTotal(monitors),90);
  context.responsePeriod='monthly'; assert.equal(context.estimateTotal(monitors),420);
  assert.equal(context.state.responses.used,363);
});
