import { checkoutBy, verifyReturnToken, captureCheckout, response, uuid } from '../lib/paypal.mjs';
export default async request => {
  if(request.method !== 'POST') return response(405,{error:'Method not allowed.'});
  try {
    const body=await request.json();
    if(!uuid(body.checkout_id)) return response(400,{error:'Checkout ID is required.'});
    const row=await checkoutBy('id',body.checkout_id);
    verifyReturnToken(row,body.state);
    if(!row.paypal_order_id || row.paypal_order_id !== body.paypal_order_id) return response(409,{error:'PayPal order does not match this checkout.'});
    if(Date.now()-Date.parse(row.created_at)>3*60*60*1000 && row.status==='created') return response(409,{error:'Checkout expired. Contact the fundraiser administrator if you approved a payment.'});
    return response(200,{success:true,checkout:await captureCheckout(row)});
  }catch(error){return response(error.status||500,{error:error.message||'Payment verification failed.'});}
};
