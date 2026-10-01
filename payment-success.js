document.addEventListener('DOMContentLoaded', async () => {
 const heading=document.querySelector('h1'),message=document.querySelector('#payment-message'),note=document.querySelector('.payment-result-note');
 const params=new URLSearchParams(location.search);
 const checkout=params.get('checkout'),state=params.get('state'),paypalOrder=params.get('token');
 heading.textContent='Verifying Payment';message.textContent='Please wait while Friends of 323 verifies your PayPal payment.';
 if(!checkout||!state||!paypalOrder){heading.textContent='Payment Not Verified';message.textContent='The PayPal verification link is incomplete. Your cart has been kept.';return;}
 async function verify(){
  try{
   const res=await fetch('/.netlify/functions/paypal-capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkout_id:checkout,state,paypal_order_id:paypalOrder})});
   const data=await res.json();if(!res.ok||!data.success)throw Error(data.error||'Payment could not be verified.');
   const payment=data.checkout;heading.textContent=payment.environment==='sandbox'?'Sandbox Payment Verified':'Payment Received';
   message.textContent=`${payment.store_order_number} — ${new Intl.NumberFormat('en-US',{style:'currency',currency:payment.currency}).format(payment.amount)}. PayPal reference: ${payment.capture_id}.`;
   note.textContent=payment.environment==='sandbox'?'This was a PayPal sandbox transaction. No real money moved, no production coffee order was created, and no Scout credit was added.':'Your verified payment has been recorded against your coffee order.';
   for(const key of ['friendsOf323StorefrontCart','friendsOf323CheckoutDraft','friendsOf323PendingOrder'])localStorage.removeItem(key);
   sessionStorage.removeItem('friends323PaypalAttempt');
   history.replaceState({},'',location.pathname);
  }catch(error){
   heading.textContent='Payment Verification Needs Attention';message.textContent=error.message;
   note.textContent='Your cart has been kept. Retry verification here before starting another payment.';
   let retry=document.querySelector('#retry-verification');if(!retry){retry=document.createElement('button');retry.id='retry-verification';retry.className='checkout-primary-link';retry.textContent='Retry Verification';note.after(retry);}
   retry.onclick=async()=>{retry.disabled=true;await verify();retry.disabled=false;};
  }
 }
 await verify();
});
