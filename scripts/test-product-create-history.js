'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','backend','server.js'),'utf8');
const start=source.indexOf('app.post("/productos",');
const handler=source.slice(start,source.indexOf('// Listar productos',start));
const audit=source.slice(source.indexOf('async function logHistorialProducto('),source.indexOf('// Pagina principal'));
async function simulate(o={}){
 let fn,tx=false,code=200,response,products=[],relations=[],history=[],saved,inserts=0,generations=0;const events=[];
 async function runQuery(sql,p){events.push(sql);if(sql==='BEGIN TRANSACTION'){assert(!tx);if(o.beginFail)throw Error('begin');tx=true;saved={products:[...products],relations:[...relations],history:[...history]};return;}assert(tx);if(sql==='ROLLBACK'){({products,relations,history}=saved);tx=false;return;}if(sql==='COMMIT'){if(o.commitFail)throw Error('commit');tx=false;return;}
 if(sql.includes('INSERT INTO productos')){inserts++;if(o.insertFail)throw Error('insert');if(o.collision&&(o.exhaust||inserts===1))throw Error('UNIQUE constraint failed: productos.codigo');assert.equal(products.length,0);products.push({id:9,nombre:p[0],precio_compra:p[2],precio_venta:p[3],stock:p[4],activo:p[8],codigo:p[16]});return {lastID:9};}
 if(sql.includes('INSERT INTO producto_proveedores')){if(o.dependencyFail)throw Error('dependency');relations.push(p);return;}
 if(sql.includes('INSERT INTO historial_productos')){if(o.historyFail)throw Error('history');history.push(p);return;}
 throw Error('Unexpected SQL '+sql);}
 const box={app:{post:(route,f)=>{assert.equal(route,'/productos');fn=f;}},runQuery,
 getQuery:async sql=>{assert(tx);if(sql.includes('FROM categorias'))return o.badCategory?null:{margen_porcentaje:0};if(sql.includes('SELECT id FROM productos'))return o.duplicate?{id:2}:null;if(sql.includes('SELECT * FROM productos'))return {...products[0]};throw Error(sql);},
 getNowParts:()=>({fecha:'date',hora:'time'}),logError:()=>{},getConfiguracionGlobal:async()=>({stock_codigo_automatico:!!o.automatic}),generarCodigoProducto:async()=>{generations++;return 'AUTO'+generations;},normalizarTipoProducto:()=> 'simple',calcularCostoFinal:()=>0,calcularPrecioSugerido:()=>0,normalizarFiscalProducto:()=>({modelo_fiscal:'legacy'}),normalizarPrecioVentaModo:()=> 'manual',calcularCostoPorRendimiento:()=>0,guardarInsumosProducto:async()=>{assert(tx);if(o.insumosFail)throw Error('insumos');},guardarProductoCompuestoConfig:()=>{throw Error('Unexpected compound branch');}};
 vm.runInNewContext(audit+'\n'+handler,box);
 const res={status:c=>{code=c;return res;},json:r=>{response=r;return r;}};
 await fn({body:{nombre:'synthetic',categoria_id:1,precio_compra:0,precio_venta:o.zero?0:150,stock:10,activo:true,proveedor_id:3,...o.body}},res);
 assert.equal(tx,false,'transaction leak');return {products,relations,history,events,code,response,inserts,generations};
}
(async()=>{let total=0;async function test(name,f){await f();total++;console.log('PASS '+name);}
 for(const zero of [false,true])await test('valid creation initial price '+(zero?0:150),async()=>{const r=await simulate({zero});assert.equal(r.code,200);assert.equal(r.response.message,'Producto guardado correctamente');assert.equal(r.response.id,9);assert.equal(r.products.length,1);assert.equal(r.relations.length,1);const h=r.history.filter(h=>h[1]==='precio_venta');assert.equal(h.length,1);assert.equal(h[0][2],null);assert.equal(h[0][3],zero?'0':'150');assert.equal(r.events[0],'BEGIN TRANSACTION');assert.equal(r.events.at(-1),'COMMIT');assert.equal(r.events.filter(e=>e==='BEGIN TRANSACTION').length,1);});
 for(const failure of ['insertFail','dependencyFail','historyFail','commitFail'])await test(failure+' rolls back all writes',async()=>{const r=await simulate({[failure]:true});assert.equal(r.code,500);assert.equal(r.products.length,0);assert.equal(r.relations.length,0);assert.equal(r.history.length,0);assert.equal(r.events.at(-1),'ROLLBACK');});
 await test('insumos failure rolls back product',async()=>{const r=await simulate({insumosFail:true,body:{usa_costos_varios:true}});assert.equal(r.code,500);assert.equal(r.products.length,0);});
 await test('manual duplicate retains 409',async()=>{const r=await simulate({duplicate:true,body:{codigo:'MANUAL'}});assert.equal(r.code,409);assert.equal(r.inserts,0);assert.equal(r.events.at(-1),'ROLLBACK');});
 await test('missing category retains 400 without insert',async()=>{const r=await simulate({badCategory:true});assert.equal(r.code,400);assert.equal(r.inserts,0);});
 for(const body of [{nombre:''},{categoria_id:null},{precio_venta:-1}])await test('payload rejected before transaction '+JSON.stringify(body),async()=>{const r=await simulate({body});assert.equal(r.code,400);assert.equal(r.events.length,0);});
 await test('automatic collision retries only failed insert, one publication',async()=>{const r=await simulate({automatic:true,collision:true});assert.equal(r.code,200);assert.equal(r.inserts,2);assert.equal(r.products.length,1);assert.equal(r.history.filter(h=>h[1]==='precio_venta').length,1);});
 await test('automatic exhaustion retains 409 and full rollback',async()=>{const r=await simulate({automatic:true,collision:true,exhaust:true});assert.equal(r.code,409);assert.equal(r.inserts,5);assert.equal(r.products.length,0);assert.equal(r.history.length,0);});
 await test('failed BEGIN does not rollback foreign transaction',async()=>{const r=await simulate({beginFail:true});assert.equal(r.code,500);assert.equal(r.events.length,1);});
 console.log(JSON.stringify({total,passed:total,failed:0,sqlite:false,http:false,permissions:'unchanged global middleware; static only'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
