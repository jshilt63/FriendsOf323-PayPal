import { paypal, db, checkoutBy, reconcileCapture, response, paymentEnvironment } from '../lib/paypal.mjs';
export default async request => {
  if(request.method!=='POST') return response(405,{error:'Method not allowed.'});
  try {
    const environment=paymentEnvironment();
    if(!process.env.PAYPAL_WEBHOOK_ID) return response(503,{error:'PAYPAL_WEBHOOK_ID is missing.'});
    const raw=await request.text(); const event=JSON.parse(raw);
    const data={transmission_id:request.headers.get('paypal-transmission-id'),transmission_time:request.headers.get('paypal-transmission-time'),cert_url:request.headers.get('paypal-cert-url'),auth_algo:request.headers.get('paypal-auth-algo'),transmission_sig:request.headers.get('paypal-transmission-sig'),webhook_id:process.env.PAYPAL_WEBHOOK_ID};
    if(Object.values(data).some(value=>!value)) return response(400,{error:'PayPal signature headers are missing.'});
    const serialized=JSON.stringify(data);
    const verified=await paypal('/v1/notifications/verify-webhook-signature',{method:'POST',rawBody:serialized.slice(0,-1)+',"webhook_event":'+raw+'}'});
    if(verified.verification_status!=='SUCCESS') return response(401,{error:'Invalid PayPal webhook signature.'});
    if(!event.id || !event.event_type) return response(400,{error:'Invalid PayPal event.'});
    const saved=await db(`/rest/v1/paypal_webhook_events?event_id=eq.${encodeURIComponent(event.id)}&environment=eq.${environment}&limit=1`);
    if(saved?.[0]?.processed_at) return response(200,{received:true,duplicate:true});
    if(!saved?.length) await db('/rest/v1/paypal_webhook_events?on_conflict=environment,event_id',{method:'POST',prefer:'resolution=ignore-duplicates,return=representation',body:{environment,event_id:event.id,event_type:event.event_type}});
    if(['PAYMENT.CAPTURE.COMPLETED','CHECKOUT.ORDER.COMPLETED'].includes(event.event_type)) {
      const id=event.resource?.supplementary_data?.related_ids?.order_id || (event.event_type==='CHECKOUT.ORDER.COMPLETED'?event.resource?.id:null);
      if(id) {
        const rows=await db(`/rest/v1/paypal_checkouts?paypal_order_id=eq.${encodeURIComponent(id)}&environment=eq.${environment}&limit=1`);
        if(rows?.[0]) await reconcileCapture(rows[0],await paypal(`/v2/checkout/orders/${encodeURIComponent(id)}`));
      }
    } else if(event.event_type==='PAYMENT.CAPTURE.REFUNDED') {
      const resource=event.resource || {};
      const captureId=resource.supplementary_data?.related_ids?.capture_id || resource.links?.find(link=>link.rel==='up')?.href?.match(/\/captures\/([A-Z0-9]+)(?:\/|$)/)?.[1];
      if(!captureId) return response(409,{error:'Refund event has no capture reference.'});
      let rows=await db(`/rest/v1/paypal_checkouts?capture_id=eq.${encodeURIComponent(captureId)}&environment=eq.${environment}&limit=1`);
      // Refunds may arrive before the completed-capture webhook or buyer return.
      if(!rows?.length) {
        const capture=await paypal(`/v2/payments/captures/${encodeURIComponent(captureId)}`);
        if(capture.custom_id) rows=await db(`/rest/v1/paypal_checkouts?id=eq.${encodeURIComponent(capture.custom_id)}&environment=eq.${environment}&limit=1`);
        if(rows?.[0]) {
          const row=rows[0], order=await paypal(`/v2/checkout/orders/${encodeURIComponent(row.paypal_order_id)}`);
          const unit=order.purchase_units?.[0];
          if(order.id!==row.paypal_order_id || unit?.custom_id!==row.id || !unit?.payments?.captures?.some(c=>c.id===captureId)) return response(409,{error:'Refund capture does not match checkout.'});
          await db('/rest/v1/rpc/complete_paypal_checkout',{method:'POST',body:{p_checkout_id:row.id,p_paypal_order_id:order.id,p_capture_id:captureId,p_amount:Number(capture.amount.value),p_currency:capture.amount.currency_code,p_fee:capture.seller_receivable_breakdown?.paypal_fee?.value?Number(capture.seller_receivable_breakdown.paypal_fee.value):null}});
        }
      }
      if(rows?.[0]) {
        const refund=await paypal(`/v2/payments/refunds/${encodeURIComponent(resource.id)}`);
        if(refund.status!=='COMPLETED') return response(409,{error:'Refund is not complete.'});
        await db('/rest/v1/rpc/record_paypal_refund',{method:'POST',body:{p_checkout_id:rows[0].id,p_refund_id:refund.id,p_amount:Number(refund.amount.value),p_currency:refund.amount.currency_code,p_reason:'Refund confirmed by PayPal webhook',p_user_id:null}});
      }
    }
    await db(`/rest/v1/paypal_webhook_events?event_id=eq.${encodeURIComponent(event.id)}&environment=eq.${environment}`,{method:'PATCH',body:{processed_at:new Date().toISOString()}});
    return response(200,{received:true});
  }catch(error){return response(error.status||500,{error:error.message||'Webhook processing failed.'});}
};
