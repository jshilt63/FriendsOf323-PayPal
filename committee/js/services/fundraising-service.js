import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";

export const FundraisingService = {
  async summary() {
    const [summaryResult, scoutsResult] = await Promise.all([
      supabase.from("scout_summary").select("*").order("is_general_fund", { ascending: false }).order("last_name").order("first_name"),
      supabase.from("scouts").select("id,den_id,dens(den_number,current_rank_working_toward)")
    ]);
    const summary = unwrap(summaryResult);
    const scouts = unwrap(scoutsResult);
    const scoutMap = new Map(scouts.map(scout => [scout.id, scout]));
    return summary.map(row => ({ ...row, scouts: scoutMap.get(row.scout_id) || null }));
  },
  async scouts() {
    return unwrap(await supabase.from("scouts")
      .select("id,first_name,last_name,is_general_fund,is_active")
      .order("is_general_fund",{ascending:false}).order("last_name").order("first_name"));
  },
  async ledger(scoutId) { return unwrap(await supabase.from("scout_credit_ledger").select("*").eq("scout_id",scoutId).order("entry_date",{ascending:false})); },
  async transactions() {
    const [transactions,profiles]=await Promise.all([
      supabase.from("scout_credit_transactions").select("*,scouts(first_name,last_name,is_general_fund)").order("transaction_date",{ascending:false}).order("created_at",{ascending:false}),
      supabase.from("user_profiles").select("id,display_name")
    ]);
    const names=new Map(unwrap(profiles).map(profile=>[profile.id,profile.display_name]));
    return unwrap(transactions).map(row=>({...row,entered_by:names.get(row.created_by)||null}));
  },
  async createTransaction(payload) { return unwrap(await supabase.from("scout_credit_transactions").insert(payload).select().single()); },
  async payouts() {
    return unwrap(await supabase.from("credit_payouts").select("*").order("created_at",{ascending:false}));
  },
  async bankDepositsAvailable() {
    const [deposits, allocations, payouts] = await Promise.all([
      supabase.from("pack_bank_deposits").select("id,amount"),
      supabase.from("pack_bank_deposit_allocations").select("deposit_id,payout_id,amount"),
      supabase.from("credit_payouts").select("id,status")
    ]);
    const depositRows = unwrap(deposits, "Pack bank deposits could not be loaded.");
    const allocationRows = unwrap(allocations, "Bank deposit allocations could not be loaded.");
    const active = new Set(unwrap(payouts, "Payouts could not be loaded.").filter(row => ["draft", "submitted", "paid"].includes(row.status)).map(row => row.id));
    return Math.max(0, depositRows.reduce((sum,row) => sum + Number(row.amount),0)
      - allocationRows.filter(row => active.has(row.payout_id)).reduce((sum,row) => sum + Number(row.amount),0));
  },
  async payoutReport(payoutId) {
    return unwrap(await supabase.from("credit_payout_report").select("*").eq("payout_id",payoutId).order("scout_last_name").order("scout_first_name"));
  },
  async payoutInfo() {
    const { data:{ session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Your session has expired. Sign in again.");
    const result = await fetch("/.netlify/functions/stripe-payout-info", {
      method:"GET",
      headers:{Authorization:`Bearer ${session.access_token}`}
    });
    const body = await result.json().catch(()=>({}));
    if (!result.ok) throw new Error(body.error || "Stripe payout balance could not be loaded.");
    return body;
  },
  async createPayout({purpose, lines, bankOffsetAmount = 0}) {
    const { data:{ session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Your session has expired. Sign in again.");
    const requestKey = crypto.randomUUID();
    const result = await fetch("/.netlify/functions/create-credit-payout", {
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
      body:JSON.stringify({request_key:requestKey,purpose,lines,bank_offset_amount:bankOffsetAmount})
    });
    const body = await result.json().catch(()=>({}));
    if (!result.ok) throw new Error(body.error || "The Stripe payout could not be created.");
    return body;
  },
  async treasurerSnapshot() {
    return unwrap(await supabase.from("order_items")
      .select("scout_id,quantity,line_total,fundraising_credit_total,scouts!inner(first_name,last_name,is_general_fund,is_active),orders!inner(record_status,payment_status)")
      .eq("orders.record_status", "active")
      .eq("orders.payment_status", "paid")
      .eq("scouts.is_active", true));
  },
  async productReport() {
    return unwrap(await supabase.from("order_items").select("quantity,line_total,fundraising_credit_total,products(product_name,sku,bag_size,supplier_name,supplier_product_name),orders!inner(record_status,order_date)").eq("orders.record_status","active"));
  },
  async customerReport() { return unwrap(await supabase.from("orders").select("id,record_status,customer_id,customers(first_name,last_name,company_name),order_items(quantity,line_total)").eq("record_status","active")); }
};
