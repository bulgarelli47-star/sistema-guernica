'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','backend','server.js'),'utf8');
const start=source.indexOf('app.patch("/productos/aumento-masivo"');
const handler=source.slice(start,source.indexOf('app.patch("/productos/:id/reactivar"',start));
const audit=source.slice(source.indexOf('async function logHistorialProducto('),source.indexOf('// Pagina principal'));
async function simulate(o={}){
 let products=[1,2,3].map(id=>({id,precio_venta:o.zero?0:10.11*id,precio_compra:5.13*id,costo_final:6.17*id,activo:1,eliminado:0,modelo_fiscal:o.normalized&&id===2?'normalizado':'legacy'}));
 const initial=JSON.stringify(products);let history=[],tx=false,saved,fn,code=200,body,updates=0;const events=[];
 const box={app:{patch:(route,f)=>{assert.equal(route,'/productos/aumento-masivo');fn=f;}},logError:()=>{},getNowParts:()=>({fecha:'date',hora:'time'}),
 allQuery:async(sql,params)=>{assert(tx);assert(sql.includes('SELECT *'));assert(sql.includes('activo = 1'));assert(sql.includes('COALESCE(eliminado, 0) = 0'));assert(sql.includes('proveedor_id = ?'));assert(sql.includes('categoria_id = ?'));assert.equal(params.join(','),'4,5');events.push('select');return o.empty?[]:products.map(p=>({...p}));},
 getQuery:async(sql,params)=>{assert(tx);return {...products.find(p=>p.id===params[0])};},
 runQuery:async(sql,p)=>{events.push(sql);if(sql==='BEGIN TRANSACTION'){assert(!tx);if(o.beginFail)throw Error('begin');saved={products:products.map(x=>({...x})),history:[...history]};tx=true;return;}assert(tx);if(sql==='ROLLBACK'){products=saved.products;history=saved.history;tx=false;return;}if(sql==='COMMIT'){if(o.commitFail)throw Error('commit');tx=false;return;}if(sql.startsWith('UPDATE productos')){updates++;if(o.updateFail&&updates===2)throw Error('update');const row=products.find(x=>x.id===p[3]);[row.precio_compra,row.precio_venta,row.costo_final]=p;return;}assert(sql.includes('INSERT INTO historial_productos'));if(o.historyFail&&p[0]===2)throw Error('history');history.push(p);}};
 vm.runInNewContext(audit+'\n'+handler,box);
 const res={status:c=>{code=c;return res;},json:b=>{body=b;return b;}};
 await fn({body:{porcentaje:12.5,campo:o.field||'precio_venta',proveedor_id:4,categoria_id:5,...o.body}},res);
 assert.equal(tx,false);return {products,history,initial,events,code,body};
}
(async()=>{let total=0;async function test(name,f){await f();total++;console.log('PASS '+name);}
 await test('valid batch: exact prices, old/new history, single commit',async()=>{const r=await simulate();assert.equal(r.code,200);assert.equal(r.body.cantidad,3);assert.equal(r.history.length,3);for(let i=0;i<3;i++){const old=10.11*(i+1),next=Math.round(old*1.125*100)/100;assert.equal(r.products[i].precio_venta,next);const h=r.history.find(h=>h[0]===i+1);assert.equal(h[1],'precio_venta');assert.equal(h[2],String(old));assert.equal(h[3],String(next));}assert.equal(r.events[0],'BEGIN TRANSACTION');assert.equal(r.events.at(-1),'COMMIT');assert.equal(r.events.filter(e=>e==='BEGIN TRANSACTION').length,1);});
 await test('unchanged zero prices generate no price history',async()=>{const r=await simulate({zero:true});assert.equal(r.code,200);assert.equal(r.history.length,0);});
 for(const field of ['precio_compra','ambos'])await test('formula and rounding preserved '+field,async()=>{const r=await simulate({field});for(let i=0;i<3;i++){assert.equal(r.products[i].precio_compra,Math.round(5.13*(i+1)*1.125*100)/100);assert.equal(r.products[i].costo_final,Math.round(6.17*(i+1)*1.125*100)/100);}if(field==='precio_compra')assert(!r.history.some(h=>h[1]==='precio_venta'));});
 for(const failure of ['updateFail','historyFail','commitFail'])await test(failure+' rolls back entire batch',async()=>{const r=await simulate({[failure]:true});assert.equal(r.code,500);assert.equal(JSON.stringify(r.products),r.initial);assert.equal(r.history.length,0);assert.equal(r.events.at(-1),'ROLLBACK');});
 for(const [option,code] of [['empty',404],['normalized',409]])await test(option+' rejection preserved',async()=>{const r=await simulate({[option]:true});assert.equal(r.code,code);assert(!r.events.some(e=>e.startsWith('UPDATE')));assert.equal(r.events.at(-1),'ROLLBACK');});
 for(const body of [{porcentaje:0},{campo:'invalid'}])await test('payload rejected before BEGIN '+JSON.stringify(body),async()=>{const r=await simulate({body});assert.equal(r.code,400);assert.equal(r.events.length,0);});
 await test('failed BEGIN no nested transaction or rollback',async()=>{const r=await simulate({beginFail:true});assert.equal(r.code,500);assert.equal(r.events.length,1);});
 console.log(JSON.stringify({total,passed:total,failed:0,sqlite:false,http:false,permissions:'global middleware unchanged; static review only'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
