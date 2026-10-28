'use strict';
// Executes only extracted handlers/auditor against an in-memory transaction model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','backend','server.js'),'utf8');
const audit=source.slice(source.indexOf('async function logHistorialProducto('),source.indexOf('// Pagina principal'));
async function simulate(route,options={}){
 const start=source.indexOf('app.patch("/productos/:id/'+route+'"');
 const handler=source.slice(start,source.indexOf('app.patch(',start+10));
 let fn,tx=false,saved,code=200,body;
 let row={id:7,nombre:'synthetic',precio_venta:options.price??150,precio_compra:20,activo:route==='inactivar'?1:0,eliminado:options.archived?1:0,observaciones:'preserved'};
 let history=[];const events=[],snapshots=[];
 const box={app:{patch:(p,f)=>{assert.equal(p,'/productos/:id/'+route);fn=f;}},getNowParts:()=>({fecha:'date',hora:'time'}),logError:()=>{},
 getQuery:async(sql,params)=>{assert(tx);assert.equal(params[0],7);assert.equal(sql,'SELECT * FROM productos WHERE id = ?');events.push('read');const copy={...row};snapshots.push(copy);return options.missing?null:copy;},
 runQuery:async(sql,params)=>{events.push(sql);if(sql==='BEGIN TRANSACTION'){assert(!tx);if(options.beginFail)throw Error('begin');tx=true;saved={row:{...row},history:[...history]};return;}assert(tx);if(sql==='ROLLBACK'){row=saved.row;history=saved.history;tx=false;return;}if(sql==='COMMIT'){if(options.commitFail)throw Error('commit');tx=false;return;}if(sql.startsWith('UPDATE productos')){if(options.updateFail)throw Error('update');row.activo=route==='inactivar'?0:1;return;}assert(sql.includes('INSERT INTO historial_productos'));if(options.historyFail)throw Error('history');history.push(params);}};
 vm.runInNewContext(audit+'\n'+handler,box);
 const res={status:c=>{code=c;return res;},json:v=>{body=v;return v;}};
 await fn({params:{id:'7'}},res);assert.equal(tx,false,'no transaction leak');return {row,history,events,snapshots,code,body};
}
(async()=>{let total=0;async function test(name,f){await f();total++;console.log('PASS '+name);}
 for(const route of ['inactivar','reactivar']){
  for(const price of [150,0])await test(route+' price '+price+' only audits activo',async()=>{const r=await simulate(route,{price});assert.equal(r.code,200);assert.equal(r.history.length,1);assert.equal(r.history[0][1],'activo');assert.equal(r.row.precio_venta,price);assert.equal(r.snapshots[0].precio_venta,price);assert.equal(r.snapshots[0].observaciones,'preserved');assert.equal(r.events[0],'BEGIN TRANSACTION');assert.equal(r.events.at(-1),'COMMIT');assert.equal(r.events.filter(e=>e==='BEGIN TRANSACTION').length,1);assert.equal(r.body.message,route==='inactivar'?'Producto inactivado correctamente':'Producto reactivado correctamente');});
  for(const failure of ['historyFail','updateFail','commitFail'])await test(route+' '+failure+' rolls back',async()=>{const r=await simulate(route,{[failure]:true});assert.equal(r.code,500);assert.equal(r.row.activo,route==='inactivar'?1:0);assert.equal(r.history.length,0);assert.equal(r.events.at(-1),'ROLLBACK');});
  await test(route+' missing retains 404',async()=>{const r=await simulate(route,{missing:true});assert.equal(r.code,404);assert.equal(r.body.message,'Producto no encontrado');assert(!r.events.some(e=>e.startsWith('UPDATE')));});
  await test(route+' failed BEGIN no rollback',async()=>{const r=await simulate(route,{beginFail:true});assert.equal(r.code,500);assert.equal(r.events.length,1);});
 }
 await test('archived cannot reactivate; restore remains required',async()=>{const r=await simulate('reactivar',{archived:true});assert.equal(r.code,400);assert(r.body.message.includes('Restaurar'));assert(!r.events.some(e=>e.startsWith('UPDATE')));assert.equal(r.history.length,0);});
 await test('inactivation preserves existing archived behavior',async()=>{const r=await simulate('inactivar',{archived:true});assert.equal(r.code,200);assert.equal(r.row.eliminado,1);});
 console.log(JSON.stringify({total,passed:total,failed:0,sqlite:false,express:false,permissions:'global middleware unchanged; not executed'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
