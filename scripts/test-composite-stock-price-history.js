'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','backend','server.js'),'utf8');
const start=source.indexOf('app.post("/productos/:id/movimientos-stock"');
const end=source.indexOf('\napp.',start+10);
const handler=source.slice(start,end);
const audit=source.slice(source.indexOf('async function logHistorialProducto('),source.indexOf('// Pagina principal'));
async function simulate(o={}){
 let product={id:7,nombre:'synthetic',tipo:'compuesto',maneja_stock:1,activo:o.inactive?0:1,eliminado:o.archived?1:0,precio_venta:o.price??150,precio_compra:150,costo_final:150,stock:10,categoria_id:1};
 let history=[],movements=[],tx=false,saved,fn,code=200,body;const events=[];const tenant=o.tenant||'A';
 async function runQuery(sql,p){events.push(sql);if(sql==='BEGIN IMMEDIATE'){assert(!tx);saved={product:{...product},history:[...history],movements:[...movements]};tx=true;return;}assert(tx);if(sql==='ROLLBACK'){({product,history,movements}=saved);tx=false;return;}if(sql==='COMMIT'){tx=false;return;}if(sql.includes('INSERT INTO movimientos_stock')){movements.push({tenant,params:p});return {lastID:11};}if(sql.includes('SET stock')){product.stock=p[0];return;}if(sql.includes('SET precio_compra')){product.precio_compra=p[0];product.costo_final=p[1];product.precio_venta=o.persisted??p[2];return;}if(sql.includes('INSERT INTO historial_productos')){if(o.historyFail&&p[1]==='precio_venta')throw Error('history');history.push({tenant,params:p});return;}throw Error(sql);}
 const box={app:{post:(r,f)=>{assert.equal(r,'/productos/:id/movimientos-stock');fn=f;}},encolarIngresoFisicoStock:f=>f(),runQuery,
 getQuery:async(sql,p)=>{assert(tx);if(sql.includes('idempotency_key'))return o.replay?{id:11}:null;if(sql.includes('FROM categorias'))return {margen_porcentaje:0};if(sql.startsWith('SELECT precio_venta'))return o.noPrice?null:{precio_venta:product.precio_venta};if(sql.startsWith('SELECT * FROM productos'))return {...product};throw Error(sql);},
 getNowParts:()=>({fecha:'date',hora:'time'}),normalizarPayloadMovimientoStockManual:x=>x,movimientoStockManualPayloadIgual:()=>true,respuestaReplayMovimientoManual:()=>({idempotent_replay:true}),TIPOS_STOCK_MANUAL_POSITIVOS:new Set(['ingreso']),buscarPosibleIngresoDuplicado:async()=>null,normalizarTipoProducto:x=>x,getComponentesProductoCompuesto:async()=>[],calcularCostoProductoCompuesto:async()=>o.cost??200,calcularPrecioSugerido:x=>x,logError:()=>{}};
 vm.runInNewContext(audit+'\n'+handler,box);
 const res={status:c=>{code=c;return res;},json:b=>{body=b;return b;}};
 await fn({params:{id:'7'},body:{tipo_movimiento:o.egress?'egreso':'ingreso',cantidad:2,motivo:'synthetic',usuario:'synthetic',idempotency_key:o.replay?'key':''}},res);
 assert.equal(tx,false);return {product,history,movements,events,code,body};
}
(async()=>{let total=0;async function test(name,f){await f();total++;console.log('PASS '+name);}
 for(const opts of [{cost:150},{price:175,cost:200}])await test('no price change '+JSON.stringify(opts),async()=>{const r=await simulate(opts);assert.equal(r.code,200);assert.equal(r.history.length,1);assert.equal(r.history[0].params[1],'stock');});
 for(const opts of [{cost:200},{cost:0},{cost:200,inactive:true},{cost:200,egress:true}])await test('real publication '+JSON.stringify(opts),async()=>{const r=await simulate(opts);assert.equal(r.code,200);const price=r.history.filter(h=>h.params[1]==='precio_venta');assert.equal(price.length,1);assert.equal(price[0].params[2],'150');assert.equal(price[0].params[3],String(opts.cost));assert.equal(r.history.filter(h=>h.params[1]==='stock').length,1);assert.equal(r.movements.length,1);assert.equal(r.events.filter(e=>e==='BEGIN IMMEDIATE').length,1);assert.equal(r.events.at(-1),'COMMIT');});
 await test('record actual persisted price, not predicted value',async()=>{const r=await simulate({persisted:201});assert.equal(r.history.find(h=>h.params[1]==='precio_venta').params[3],'201');});
 await test('archived rejected',async()=>{const r=await simulate({archived:true});assert.equal(r.code,400);assert.equal(r.history.length,0);assert.equal(r.movements.length,0);});
 await test('idempotent replay changes nothing',async()=>{const r=await simulate({replay:true});assert.equal(r.body.idempotent_replay,true);assert.equal(r.movements.length,0);assert.equal(r.history.length,0);});
 for(const opts of [{historyFail:true},{noPrice:true}])await test('verification/history failure rolls back entire movement '+JSON.stringify(opts),async()=>{const r=await simulate(opts);assert.equal(r.code,500);assert.equal(r.product.stock,10);assert.equal(r.product.precio_venta,150);assert.equal(r.product.costo_final,150);assert.equal(r.movements.length,0);assert.equal(r.history.length,0);assert.equal(r.events.at(-1),'ROLLBACK');});
 await test('isolated supplied tenant simulations never mix records',async()=>{const [a,b]=await Promise.all([simulate({tenant:'A',cost:200}),simulate({tenant:'B',cost:300})]);assert(a.history.every(h=>h.tenant==='A'));assert(b.history.every(h=>h.tenant==='B'));assert.equal(a.product.precio_venta,200);assert.equal(b.product.precio_venta,300);});
 console.log(JSON.stringify({total,passed:total,failed:0,sqlite:false,http:false,tenant:'simulation only; runtime coordinator not executed'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
