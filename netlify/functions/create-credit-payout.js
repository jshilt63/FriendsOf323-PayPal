const tls = require("node:tls");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

exports.handler = async function handler(event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod !== "POST") return response(405,{error:"Method not allowed."},headers);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) {
    return response(500,{error:"Payout configuration is incomplete."},headers);
  }

  let payout = null;
  let stripePayoutCreated = null;
  try {
    const token = getBearerToken(event.headers.authorization || event.headers.Authorization);
    const caller = await verifyUser(token);
    const profile = await getProfile(caller.id);
    if (!profile?.is_active || profile.role !== "coffee_bean") {
      return response(403,{error:"Coffee Bean access is required."},headers);
    }

    const body = JSON.parse(event.body || "{}");
    const requestKey = String(body.request_key || "").trim();
    const purpose = String(body.purpose || "").trim();
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const bankOffset = Number(body.bank_offset_amount || 0);

    if (!/^[0-9a-f-]{36}$/i.test(requestKey)) return response(400,{error:"A valid payout request ID is required."},headers);
    if (!purpose) return response(400,{error:"Transfer purpose is required."},headers);
    if (!lines.length) return response(400,{error:"Select at least one scout to include in the payout."},headers);
    if (!Number.isFinite(bankOffset) || bankOffset < 0 || Math.abs(Math.round(bankOffset * 100) - bankOffset * 100) > 0.00001) {
      return response(400,{error:"Enter a valid bank deposit offset in dollars and cents."},headers);
    }

    const cleanLines = lines.map(line => ({
      scout_id: String(line.scout_id || "").trim(),
      amount: Number(line.amount)
    })).filter(line => line.scout_id && Number.isFinite(line.amount) && line.amount > 0);
    if (cleanLines.length !== lines.length) return response(400,{error:"One or more scout payout amounts are invalid."},headers);

    payout = await rpc("create_credit_payout_draft", {
      p_request_key: requestKey,
      p_created_by: caller.id,
      p_purpose: purpose,
      p_lines: cleanLines
    });

    if (payout.status === "submitted" || payout.status === "paid") {
      return response(200,{success:true,payout,already_processed:true},headers);
    }

    const split = await rpc("reserve_pack_bank_offset", {
      p_payout_id: payout.id,
      p_amount: bankOffset
    });
    payout.bank_offset_amount = Number(split.bank_offset_amount);
    payout.stripe_amount = Number(split.stripe_amount);

    const amountCents = Math.round(payout.stripe_amount * 100);
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error("Calculated Stripe payout amount is invalid.");

    if (amountCents === 0) {
      await rpc("complete_bank_only_credit_payout", {p_payout_id:payout.id});
      const emailResults = await sendParentNotifications(payout.id,purpose);
      return response(200,{success:true,payout:{...payout,status:"paid"},parent_notifications:emailResults},headers);
    }

    const params = new URLSearchParams();
    params.set("amount", String(amountCents));
    params.set("currency", "usd");
    params.set("description", `Friends of 323 ${payout.payout_number} - ${purpose}`.slice(0, 350));
    params.set("metadata[credit_payout_id]", payout.id);
    params.set("metadata[payout_number]", payout.payout_number);
    params.set("metadata[purpose]", purpose.slice(0, 500));

    const stripePayout = await stripePost("/v1/payouts", params, `friends323-credit-payout-${payout.id}`);
    stripePayoutCreated = stripePayout;
    const arrivalDate = stripePayout.arrival_date ? new Date(Number(stripePayout.arrival_date) * 1000).toISOString().slice(0,10) : null;

    await rpc("mark_credit_payout_submitted", {
      p_payout_id: payout.id,
      p_stripe_payout_id: stripePayout.id,
      p_arrival_date: arrivalDate
    });

    const emailResults = await sendParentNotifications(payout.id, purpose);

    return response(200,{
      success:true,
      payout:{...payout,status:"submitted",stripe_payout_id:stripePayout.id,stripe_arrival_date:arrivalDate},
      parent_notifications:emailResults
    },headers);
  } catch (error) {
    console.error("create-credit-payout error", error);
    if (payout?.id && payout?.status === "draft" && !stripePayoutCreated?.id) {
      try { await rpc("fail_credit_payout_draft", {p_payout_id:payout.id,p_message:error.message || "Stripe payout failed."}); }
      catch (rollbackError) { console.error("Unable to release payout reservation", rollbackError); }
    }
    return response(500,{error:stripePayoutCreated?.id
      ? `Stripe created payout ${stripePayoutCreated.id}, but the portal could not finish recording it. Do not retry; reconcile in Stripe.`
      : error.message || "Payout could not be created."},headers);
  }
};

async function sendParentNotifications(payoutId, purpose) {
  const report = await restGet(`/rest/v1/credit_payout_report?payout_id=eq.${encodeURIComponent(payoutId)}&select=*`);
  const results = [];
  for (const row of report) {
    const scoutName = [row.scout_first_name,row.scout_last_name].filter(Boolean).join(" ") || "your Scout";
    const parentName = [row.guardian_first_name,row.guardian_last_name].filter(Boolean).join(" ");
    const email = String(row.guardian_email || "").trim().toLowerCase();
    if (!email) {
      await updateLineNotification(row.line_id,"no_email",null,null);
      results.push({scout:scoutName,status:"no_email"});
      continue;
    }
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      await updateLineNotification(row.line_id,"failed",null,"Gmail configuration is missing.");
      results.push({scout:scoutName,status:"failed"});
      continue;
    }
    const amount = money(row.amount);
    const subject = `${scoutName} earned ${amount} toward ${purpose}!`;
    const greeting = parentName ? `Hello ${parentName},` : "Hello,";
    const text = `${greeting}\n\nGreat news!\n\n${scoutName}'s coffee sales efforts have reduced your ${purpose} payment by ${amount}.\n\nCoffee credit applied: ${amount}\n\nThank you for supporting the Friends of 323 coffee fundraiser!\n\nFriends of 323`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#2d332f"><h2 style="color:#174c3c">Great news!</h2><p>${escapeHtml(greeting)}</p><p><strong>${escapeHtml(scoutName)}</strong>'s coffee sales efforts have reduced your <strong>${escapeHtml(purpose)}</strong> payment by <strong>${escapeHtml(amount)}</strong>.</p><div style="padding:16px;border-radius:10px;background:#f5f0e4;margin:20px 0"><div style="font-size:13px;color:#666">Coffee credit applied</div><div style="font-size:28px;font-weight:700;color:#174c3c">${escapeHtml(amount)}</div></div><p>Thank you for supporting the Friends of 323 coffee fundraiser!</p><p>Friends of 323</p></div>`;
    try {
      await sendGmailSmtp({user:GMAIL_USER,appPassword:GMAIL_APP_PASSWORD,to:email,subject,text,html});
      await updateLineNotification(row.line_id,"sent",new Date().toISOString(),null);
      results.push({scout:scoutName,status:"sent"});
    } catch (error) {
      console.error("Parent payout email failed", {line_id:row.line_id,email,error});
      await updateLineNotification(row.line_id,"failed",null,error.message || "Email failed.");
      results.push({scout:scoutName,status:"failed"});
    }
  }
  return results;
}

async function updateLineNotification(lineId,status,sentAt,errorMessage) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/credit_payout_lines?id=eq.${encodeURIComponent(lineId)}`, {
    method:"PATCH", headers:{...adminHeaders(),Prefer:"return=minimal"},
    body:JSON.stringify({notification_status:status,notification_sent_at:sentAt,notification_error:errorMessage})
  });
  if (!result.ok) console.error("Unable to update payout notification status", await result.text());
}

function getBearerToken(header) {
  const match=String(header||"").match(/^Bearer\s+(.+)$/i);
  if(!match) throw new Error("Authentication token is missing.");
  return match[1];
}
async function verifyUser(token) {
  const result=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${token}`}});
  const body=await parseJson(result); if(!result.ok||!body.id) throw new Error("Your session is invalid or expired."); return body;
}
async function getProfile(userId) {
  const rows=await restGet(`/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,is_active`); return rows[0]||null;
}
async function rpc(name,body) {
  const result=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:adminHeaders(),body:JSON.stringify(body)});
  const parsed=await parseJson(result); if(!result.ok) throw new Error(parsed.message||parsed.error||`${name} failed.`); return parsed;
}
async function restGet(path) {
  const result=await fetch(`${SUPABASE_URL}${path}`,{headers:adminHeaders()}); const parsed=await parseJson(result); if(!result.ok) throw new Error(parsed.message||"Database lookup failed."); return parsed;
}
async function stripePost(path,params,idempotencyKey) {
  const result=await fetch(`https://api.stripe.com${path}`,{method:"POST",headers:{Authorization:`Bearer ${STRIPE_SECRET_KEY}`,"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":idempotencyKey},body:params.toString()});
  const body=await parseJson(result); if(!result.ok) throw new Error(body?.error?.message||"Stripe payout failed."); return body;
}
function adminHeaders(){return {"Content-Type":"application/json",apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`};}
async function parseJson(result){return result.json().catch(()=>({}));}
function response(statusCode,body,headers){return {statusCode,headers,body:JSON.stringify(body)};}
function money(value){const n=Number(value||0);return `$${(Number.isFinite(n)?n:0).toFixed(2)}`;}
function escapeHtml(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function encodeHeader(value){const text=String(value??"");return /^[\x20-\x7E]*$/.test(text)?text:`=?UTF-8?B?${Buffer.from(text,"utf8").toString("base64")}?=`;}
function smtpCommand(socket,command,acceptedCodes){return new Promise((resolve,reject)=>{let buffer="";const cleanup=()=>{socket.off("data",onData);socket.off("error",onError);socket.off("timeout",onTimeout)};const onError=e=>{cleanup();reject(e)};const onTimeout=()=>{cleanup();reject(new Error("Gmail SMTP connection timed out."))};const onData=chunk=>{buffer+=chunk.toString("utf8");const lines=buffer.split(/\r?\n/).filter(Boolean);if(!lines.length)return;const last=lines[lines.length-1];if(!/^\d{3} /.test(last))return;cleanup();const code=Number(last.slice(0,3));if(!acceptedCodes.includes(code))return reject(new Error(`Gmail SMTP rejected command (${code}): ${last}`));resolve(buffer)};socket.on("data",onData);socket.on("error",onError);socket.on("timeout",onTimeout);if(command!==null)socket.write(`${command}\r\n`)})}
async function sendGmailSmtp({user,appPassword,to,subject,text,html}){const socket=tls.connect({host:"smtp.gmail.com",port:465,servername:"smtp.gmail.com",rejectUnauthorized:true});socket.setTimeout(20000);await smtpCommand(socket,null,[220]);await smtpCommand(socket,"EHLO friendsof323.netlify.app",[250]);await smtpCommand(socket,"AUTH LOGIN",[334]);await smtpCommand(socket,Buffer.from(user,"utf8").toString("base64"),[334]);await smtpCommand(socket,Buffer.from(appPassword.replace(/\s+/g,""),"utf8").toString("base64"),[235]);await smtpCommand(socket,`MAIL FROM:<${user}>`,[250]);await smtpCommand(socket,`RCPT TO:<${to}>`,[250,251]);await smtpCommand(socket,"DATA",[354]);const boundary=`f323_${Date.now()}_${Math.random().toString(16).slice(2)}`;const message=[`From: ${encodeHeader("Friends of 323 Coffee")} <${user}>`,`To: <${to}>`,`Subject: ${encodeHeader(subject)}`,"MIME-Version: 1.0",`Content-Type: multipart/alternative; boundary="${boundary}"`,"",`--${boundary}`,'Content-Type: text/plain; charset="UTF-8"',"Content-Transfer-Encoding: 8bit","",text,"",`--${boundary}`,'Content-Type: text/html; charset="UTF-8"',"Content-Transfer-Encoding: 8bit","",html,"",`--${boundary}--`,""].join("\r\n").replace(/^\./gm,"..");await smtpCommand(socket,`${message}\r\n.`,[250]);await smtpCommand(socket,"QUIT",[221]);socket.end();}
