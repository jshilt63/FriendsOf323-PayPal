import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";
export const ProductsService = {
  async list() { return unwrap(await supabase.from("products").select("*").order("product_name").order("bag_size")); },
  async save(id,payload) { return unwrap(await (id ? supabase.from("products").update(payload).eq("id",id).select().single() : supabase.from("products").insert(payload).select().single())); }
};
