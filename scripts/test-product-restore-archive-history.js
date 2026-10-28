'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','backend','server.js'),'utf8');
const audit=source.slice(source.indexOf('async function logHistorialProducto('),source.indexOf('// Pagina principal'));
async function simulate(mode,o={}){
 const start=source.indexOf(mode==='restore'?'app.patch("/productos/:id/restaurar"':'app.delete("/productos/:id",');
 const end=source.indexOf(mode==='restore'?'app.delete("/productos/:id",':'app.get("/categorias"',start+10);
 let row={id:7,nombre:'synthetic',codigo:'CODE',precio_venta:o.price??150,stock:10,activo:mode==='restore'?0:1,eliminado:mode==='restore'?1:0,observaciones:'full snapshot',...o.row};
 let history=[],tx=false,saved,fn,code=200,body;const events=[],snapshots=[];
 const box={app:{patch:(p,f)=>fn=f,delete:(p,f)=>fn=f},getClaveAutorizacion:async()=> 'synthetic',requerirClaveConfigurada:(key,res)=>{if(o.unconfigured){res.status(403).json({message:'unconfigured'});return false;}return true;},getNowParts:()=>({fecha:'date',hora:'time'}),logError:()=>{},
 getQuery:async(sql,params)=>{assert(tx);events.push('read');if(sql.includes('COUNT(*)'))return {total:o.component?1:0};if(sql.includes('WHERE codigo'))return o.conflict?{id:8}:null;if(o.missing)return null;if(sql.startsWith('SELECT *')){const copy={...row};snapshots.push(copy);return copy;}return {id:row.id,nombre:row.nombre};},
 runQuery:async(sql,p)=>{events.push(sql);if(sql==='BEGIN TRANSACTION'){assert(!tx);if(o.beginFail)throw Error('begin');tx=true;saved={row:{...row},history:[...history]};return;}assert(tx);if(sql==='ROLLBACK'){row=saved.row;history=saved.history;tx=false;return;}if(sql==='COMMIT'){if(o.commitFail)throw Error('commit');tx=false;return;}if(sql.startsWith('UPDATE productos')){if(o.updateFail)throw Error('update');row={...row,activo:mode==='restore'?1:0,eliminado:mode==='restore'?0:1};return;}assert(sql.includes('INSERT INTO historial_productos'));if(o.historyFail)throw Error('history');history.push(p);}};
 vm.runInNewContext(audit+'\n'+source.slice(start,end),box);
 const res={status:c=>{code=c;return res;},json:b=>{body=b;return b;}};
 await fn({params:{id:'7'},body:{clave:o.badKey?'invalid':'synthetic'}},res);assert.equal(tx,false,'transaction leak');return {row,history,events,snapshots,code,body};
}
(async()=>{let total=0;async function test(name,f){await f();total++;console.log('PASS '+name);}
 for(const mode of ['restore','archive']){
  for(const price of [150,0])await test(mode+' valid price '+price+' true state history only',async()=>{const r=await simulate(mode,{price});assert.equal(r.code,200);assert.equal(r.history.length,2);assert.equal(r.history.map(h=>h[1]).sort().join(','),'activo,eliminado');assert.equal(r.row.precio_venta,price);assert.equal(r.snapshots[0].precio_venta,price);assert.equal(r.snapshots[0].observaciones,'full snapshot');assert.equal(r.events[0],'BEGIN TRANSACTION');assert.equal(r.events.at(-1),'COMMIT');assert.equal(r.events.filter(e=>e==='BEGIN TRANSACTION').length,1);assert.equal(r.body.message,mode==='restore'?'Producto restaurado correctamente.':'Producto archivado correctamente.');if(mode==='archive')assert.equal(r.body.archivado,true);});
  for(const failure of ['updateFail','historyFail','commitFail'])await test(mode+' '+failure+' full rollback',async()=>{const r=await simulate(mode,{[failure]:true});assert.equal(r.code,500);assert.equal(r.row.eliminado,mode==='restore'?1:0);assert.equal(r.history.length,0);assert.equal(r.events.at(-1),'ROLLBACK');});
  await test(mode+' missing retains 404',async()=>{const r=await simulate(mode,{missing:true});assert.equal(r.code,404);assert(!r.events.some(e=>e.startsWith('UPDATE')));});
  await test(mode+' failed BEGIN no rollback',async()=>{const r=await simulate(mode,{beginFail:true});assert.equal(r.code,500);assert.equal(r.events.length,1);});
 }
 await test('restore nonarchived retains 400',async()=>{const r=await simulate('restore',{row:{eliminado:0}});assert.equal(r.code,400);assert.equal(r.history.length,0);});
 await test('restore code conflict retains 409',async()=>{const r=await simulate('restore',{conflict:true});assert.equal(r.code,409);assert.equal(r.history.length,0);});
 await test('archive component retains 409',async()=>{const r=await simulate('archive',{component:true});assert.equal(r.code,409);assert.equal(r.history.length,0);});
 for(const option of ['badKey','unconfigured'])await test('archive '+option+' before transaction',async()=>{const r=await simulate('archive',{[option]:true});assert.equal(r.code,403);assert.equal(r.events.length,0);});
 console.log(JSON.stringify({total,passed:total,failed:0,sqlite:false,http:false,permissions:'global middleware unchanged; not executed'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
