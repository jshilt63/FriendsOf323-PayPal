import { staff, checkoutBy, refundCheckout, db, response, uuid, fail } from '../lib/paypal.mjs';
export default async request => {
  if(request.method!=='POST')return response(405,{error:'Method not allowed.'});
  try{
    const user=await staff(request);const body=await request.json();
    const reason=String(body.reason||'').trim();if(!reason)fail('A refund reason is required.');
    let row;
    if(uuid(body.checkout_id))row=await checkoutBy('id',body.checkout_id);
    else if(uuid(body.order_id)) {
      const orders=await db(`/rest/v1/orders?id=eq.${body.order_id}&select=id,payment_provider`);
      if(orders?.[0]?.payment_provider!=='paypal')fail('Historical payments must be refunded through their original provider. This repository does not call Stripe.',409);
      const rows=await db(`/rest/v1/paypal_checkouts?order_id=eq.${body.order_id}&environment=eq.live&limit=1`);
      if(!rows?.[0])fail('PayPal payment record was not found.',404);
      row=await checkoutBy('id',rows[0].id);
    }else fail('A checkout or order ID is required.');
    const checkout=await refundCheckout(row,{reason,userId:user.id});
    return response(200,{success:true,checkout,refunded_amount:checkout.refunded_amount});
  }catch(error){return response(error.status||500,{error:error.message});}
};
