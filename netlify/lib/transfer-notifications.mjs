import tls from "node:tls";
import {db} from "./paypal.mjs";
function money(value){const n=Number(value||0);return `$${(Number.isFinite(n)?n:0).toFixed(2)}`;}
function escapeHtml(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function encodeHeader(value){const text=String(value??"");return /^[\x20-\x7E]*$/.test(text)?text:`=?UTF-8?B?${Buffer.from(text,"utf8").toString("base64")}?=`;}
function smtpCommand(socket,command,acceptedCodes){return new Promise((resolve,reject)=>{let buffer="";const cleanup=()=>{socket.off("data",onData);socket.off("error",onError);socket.off("timeout",onTimeout)};const onError=e=>{cleanup();reject(e)};const onTimeout=()=>{cleanup();reject(new Error("Gmail SMTP connection timed out."))};const onData=chunk=>{buffer+=chunk.toString("utf8");const lines=buffer.split(/\r?\n/).filter(Boolean);if(!lines.length)return;const last=lines[lines.length-1];if(!/^\d{3} /.test(last))return;cleanup();const code=Number(last.slice(0,3));if(!acceptedCodes.includes(code))return reject(new Error(`Gmail SMTP rejected command (${code}): ${last}`));resolve(buffer)};socket.on("data",onData);socket.on("error",onError);socket.on("timeout",onTimeout);if(command!==null)socket.write(`${command}\r\n`)})}
async function sendGmailSmtp({user,appPassword,to,subject,text,html}){const socket=tls.connect({host:"smtp.gmail.com",port:465,servername:"smtp.gmail.com",rejectUnauthorized:true});socket.setTimeout(20000);await smtpCommand(socket,null,[220]);await smtpCommand(socket,"EHLO friendsof323.netlify.app",[250]);await smtpCommand(socket,"AUTH LOGIN",[334]);await smtpCommand(socket,Buffer.from(user,"utf8").toString("base64"),[334]);await smtpCommand(socket,Buffer.from(appPassword.replace(/\s+/g,""),"utf8").toString("base64"),[235]);await smtpCommand(socket,`MAIL FROM:<${user}>`,[250]);await smtpCommand(socket,`RCPT TO:<${to}>`,[250,251]);await smtpCommand(socket,"DATA",[354]);const boundary=`f323_${Date.now()}_${Math.random().toString(16).slice(2)}`;const message=[`From: ${encodeHeader("Friends of 323 Coffee")} <${user}>`,`To: <${to}>`,`Subject: ${encodeHeader(subject)}`,"MIME-Version: 1.0",`Content-Type: multipart/alternative; boundary="${boundary}"`,"",`--${boundary}`,'Content-Type: text/plain; charset="UTF-8"',"Content-Transfer-Encoding: 8bit","",text,"",`--${boundary}`,'Content-Type: text/html; charset="UTF-8"',"Content-Transfer-Encoding: 8bit","",html,"",`--${boundary}--`,""].join("\r\n").replace(/^\./gm,"..");await smtpCommand(socket,`${message}\r\n.`,[250]);await smtpCommand(socket,"QUIT",[221]);socket.end();}

export async function notifyTransfer(transfer) {
 const results=[];
 const lines=await db(`/rest/v1/paypal_pack_transfer_lines?transfer_id=eq.${transfer.id}&select=id,scout_id,amount,notification_status,scouts(first_name,last_name)`);
 for(const line of lines) {
  if(line.notification_status!=="pending")continue;
  const links=await db(`/rest/v1/scout_guardians?scout_id=eq.${line.scout_id}&receive_credit_notifications=eq.true&select=is_primary,guardians(first_name,last_name,email,is_active)&order=is_primary.desc`);
  const guardian=links.find(l=>l.guardians?.is_active && l.guardians?.email)?.guardians;
  let status="no_email";
  const name=[line.scouts.first_name,line.scouts.last_name].filter(Boolean).join(" ");
  if(guardian && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
   const claim=await db(`/rest/v1/paypal_pack_transfer_lines?id=eq.${line.id}&notification_status=eq.pending`,{method:"PATCH",body:{notification_status:"sending"}});
   if(!claim?.length)continue;
   try {
    const text=`Hello,\n\n${name}'s coffee credit has reduced your ${transfer.purpose} payment by ${money(line.amount)}.\n\nThank you for supporting Friends of 323.`;
    await sendGmailSmtp({user:process.env.GMAIL_USER,appPassword:process.env.GMAIL_APP_PASSWORD,to:guardian.email,subject:`${name} earned ${money(line.amount)} toward ${transfer.purpose}!`,text,html:`<p>${escapeHtml(text).replaceAll("\n","<br>")}</p>`});status="sent";
   }catch(error){status="failed";}
  } else if(guardian) status="failed";
  await db(`/rest/v1/paypal_pack_transfer_lines?id=eq.${line.id}`,{method:"PATCH",body:{notification_status:status,notification_sent_at:status==="sent"?new Date().toISOString():null}});
  results.push({scout:name,status});
 }
 return results;
}
