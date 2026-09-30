import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";
export const CustomersService = {
  async list() { return unwrap(await supabase.from("customers").select("*").order("last_name").order("first_name")); },
  async save(id,payload) { return unwrap(await (id ? supabase.from("customers").update(payload).eq("id",id).select().single() : supabase.from("customers").insert(payload).select().single())); }
};
