import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaypalCheckout,captureCheckout,refundCheckout,verifyReturnToken,reconcileCapture,paymentEnvironment} from '../netlify/lib/paypal.mjs';
import captureHandler from '../netlify/functions/paypal-capture.mjs';
import webhookHandler from '../netlify/functions/paypal-webhook.mjs';
import refundHandler from '../netlify/functions/paypal-refund.mjs';
import createHandler from '../netlify/functions/paypal-create-order.mjs';
const id='00000000-0000-0000-0000-000000000001',productId='00000000-0000-0000-0000-000000000002',scoutId='00000000-0000-0000-0000-000000000003';
process.env.PAYPAL_ENV='sandbox';process.env.PAYPAL_CLIENT_ID='test-client';process.env.PAYPAL_CLIENT_SECRET='test-secret';process.env.PAYPAL_WEBHOOK_ID='test-webhook';process.env.SUPABASE_URL='https://database.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-server-key';
function fixture(){
 const records=[],calls=[],events=[];let completed=false,signature='SUCCESS';
 const cap={id:'CAPTURE1',status:'COMPLETED',amount:{currency_code:'USD',value:'12.00'},seller_receivable_breakdown:{paypal_fee:{currency_code:'USD',value:'0.91'}}};
 const order=()=>({id:'PAYPAL1',status:completed?'COMPLETED':'APPROVED',purchase_units:[{custom_id:id,payments:completed?{captures:[cap]}:undefined}],links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL1'}]});
 globalThis.fetch=async(url,options={})=>{
  url=String(url);const method=options.method||'GET',body=options.body?JSON.parse(options.body.startsWith('grant_type=')?'{}':options.body):null;calls.push({url,method,body,raw:options.body,headers:options.headers});
  assert.ok(!url.includes('stripe.com'));
  if(url.endsWith('/oauth2/token'))return Response.json({access_token:'test-access-token',expires_in:3600});
  if(url.includes('/verify-webhook-signature'))return Response.json({verification_status:signature});
  if(url.includes('/v2/checkout/orders')){
   if(url.endsWith('/capture')){completed=true;return Response.json(order());}
   return Response.json(order());
  }
  if(url.includes('/v2/payments/refunds/'))return Response.json({id:'REFUND1',status:'COMPLETED',amount:{currency_code:'USD',value:'12.00'}});
  if(url.includes('/v2/payments/captures/')&&!url.endsWith('/refund'))return Response.json({...cap,custom_id:id});
  if(url.endsWith('/refund'))return Response.json({id:'REFUND1',status:'COMPLETED',amount:{currency_code:'USD',value:'12.00'}});
  if(url.includes('/auth/v1/user'))return Response.json({id});
  if(url.includes('/user_profiles'))return Response.json([{id,role:'coffee_bean',is_active:true}]);
  if(url.includes('/products?'))return Response.json([{id:productId,product_name:'Coffee',is_active:true,sale_price:12}]);
  if(url.includes('/scouts?'))return Response.json([{id:scoutId,is_active:true}]);
  if(url.includes('/complete_paypal_checkout')){const r=records[0];r.status='completed';r.capture_id=body.p_capture_id;r.fee_amount=body.p_fee;return Response.json(r);}
  if(url.includes('/record_paypal_refund')){const r=records[0];r.status='refunded';r.refunded_amount=body.p_amount;return Response.json(r);}
  if(url.includes('/paypal_webhook_events')){
   if(method==='POST'){events.push(body);return Response.json([body]);}
   if(method==='PATCH'){events[0].processed_at=body.processed_at;return Response.json(events);}
   return Response.json(events);
  }
  if(url.includes('/paypal_checkouts')){
   if(method==='POST'){if(records.length)return Response.json([]);const row={...body,id,created_at:new Date().toISOString(),refunded_amount:0};records.push(row);return Response.json([row]);}
   if(method==='PATCH'){Object.assign(records[0],body);return Response.json(records);}
   return Response.json(records);
  }
  throw Error(`Unexpected fetch: ${url}`);
 };
 const args={request:new Request('https://preview.test/checkout'),requestKey:'00000000-0000-0000-0000-000000000099',fingerprintPayload:{cart:'same'},customer:{},items:[],coffeeSubtotal:12,processingCost:0,shippingAmount:0,fulfillment:{fulfillment_method:'pickup'}};
 return {records,calls,cap,args,order,complete:value=>completed=value,signature:value=>signature=value};
}
test('sandbox create retries reuse one checkout and one PayPal creation',async()=>{
 const f=fixture();const first=await createPaypalCheckout(f.args);const second=await createPaypalCheckout(f.args);
 assert.equal(f.records.length,1);assert.equal(first.order_id,second.order_id);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/v2/checkout/orders')).length,1);
 assert.equal(f.calls.some(c=>c.url.includes('create_storefront_order')||/\/orders\?/.test(c.url)),false);
 await assert.rejects(createPaypalCheckout({...f.args,fingerprintPayload:{cart:'changed'}}),/different cart/);
});
test('approval capture validates token and retries do not capture twice',async()=>{
 const f=fixture();await createPaypalCheckout(f.args);const creation=f.calls.find(c=>c.method==='POST'&&c.url.endsWith('/v2/checkout/orders'));const url=new URL(creation.body.payment_source.paypal.experience_context.return_url);const state=url.searchParams.get('state');
 assert.throws(()=>verifyReturnToken(f.records[0],'wrong'),/invalid/);
 const request=()=>new Request('https://preview.test/capture',{method:'POST',body:JSON.stringify({checkout_id:id,state,paypal_order_id:'PAYPAL1'})});
 assert.equal((await captureHandler(request())).status,200);assert.equal((await captureHandler(request())).status,200);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/capture')).length,1);assert.equal(f.records[0].fee_amount,0.91);
});
test('amount mismatch and pending capture cannot mark a checkout paid',async()=>{
 const f=fixture();await createPaypalCheckout(f.args);f.cap.amount.value='11.00';
 await assert.rejects(reconcileCapture(f.records[0],{...f.order(),purchase_units:[{custom_id:id,payments:{captures:[f.cap]}}]}),/total/);
 f.cap.amount.value='12.00';f.cap.status='PENDING';await assert.rejects(reconcileCapture(f.records[0],{...f.order(),purchase_units:[{custom_id:id,payments:{captures:[f.cap]}}]}),/pending/i);
 assert.equal(f.calls.some(c=>c.url.includes('complete_paypal_checkout')),false);
});
test('refund requires staff authentication and completed capture; retries avoid a second refund',async()=>{
 const f=fixture();await createPaypalCheckout(f.args);await captureCheckout(f.records[0]);
 assert.equal((await refundHandler(new Request('https://preview.test/refund',{method:'POST',body:'{}'}))).status,401);
 await refundCheckout(f.records[0],{reason:'Test refund'});await refundCheckout(f.records[0],{reason:'Retry'});
 assert.equal(f.calls.filter(c=>c.url.endsWith('/refund')).length,1);assert.equal(f.records[0].status,'refunded');
});
test('webhook rejects forged signatures and verifies the original event body',async()=>{
 const f=fixture();await createPaypalCheckout(f.args);await captureCheckout(f.records[0]);
 const raw=JSON.stringify({id:'EVENT1',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{supplementary_data:{related_ids:{order_id:'PAYPAL1'}}}},null,2);
 const headers={'paypal-transmission-id':'transmission','paypal-transmission-time':'2026-09-30T00:00:00Z','paypal-cert-url':'https://api.sandbox.paypal.com/cert','paypal-auth-algo':'SHA256withRSA','paypal-transmission-sig':'signature'};
 const request=()=>new Request('https://preview.test/webhook',{method:'POST',headers,body:raw});
 f.signature('FAILURE');assert.equal((await webhookHandler(request())).status,401);assert.equal(f.calls.some(c=>c.url.includes('paypal_webhook_events')),false);
 f.signature('SUCCESS');assert.equal((await webhookHandler(request())).status,200);assert.equal((await webhookHandler(request())).status,200);
 assert.ok(f.calls.find(c=>c.url.includes('verify-webhook-signature')).raw.includes(raw));
});
test('checkout derives totals from product data and rejects malformed product/scout IDs',async()=>{
 const f=fixture();const payload={request_key:f.args.requestKey,customer:{first_name:'Test',last_name:'Buyer',email:'test@example.com',address_line_1:'Test Street',city:'Test City',state:'MO',postal_code:'64012'},items:[{product_id:productId,quantity:1,grind:'ground',allocations:[{scout_id:scoutId,quantity:1}],unit_price:0.01}],processing_cost:0,payment_method:'online',fulfillment_method:'pickup'};
 const req=body=>new Request('https://preview.test/create',{method:'POST',body:JSON.stringify(body)});
 assert.equal((await createHandler(req(payload))).status,201);assert.equal(f.records[0].amount,12);
 const malformed=structuredClone(payload);malformed.items[0].product_id='bad-id';assert.equal((await createHandler(req(malformed))).status,400);
});
test('live mode requires a separate explicit enable flag',()=>{
 process.env.PAYPAL_ENV='live';delete process.env.PAYPAL_ENABLE_LIVE;assert.throws(paymentEnvironment,/not enabled/);process.env.PAYPAL_ENV='sandbox';
});

test('refund webhook arriving before capture recording recovers the checkout without losing the refund',async()=>{
 const f=fixture();await createPaypalCheckout(f.args);f.complete(true);f.cap.status='REFUNDED';
 const event={id:'REFUND-EVENT',event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id:'REFUND1',links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE1'}]}};
 const headers={'paypal-transmission-id':'transmission','paypal-transmission-time':'2026-09-30T00:00:00Z','paypal-cert-url':'https://api.sandbox.paypal.com/cert','paypal-auth-algo':'SHA256withRSA','paypal-transmission-sig':'signature'};
 const res=await webhookHandler(new Request('https://preview.test/webhook',{method:'POST',headers,body:JSON.stringify(event)}));
 assert.equal(res.status,200);assert.equal(f.records[0].status,'refunded');assert.equal(f.records[0].refunded_amount,12);
});
