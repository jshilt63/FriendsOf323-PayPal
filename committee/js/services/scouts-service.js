import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";

const SCOUT_SELECT = `*, dens(id,den_number,current_rank_working_toward), scout_guardians(relationship,is_primary,receive_credit_notifications,guardians(id,first_name,last_name,email,phone,is_active))`;

export const ScoutsService = {
  async list() {
    return unwrap(await supabase.from("scouts").select(SCOUT_SELECT)
      .order("is_general_fund",{ascending:false}).order("last_name").order("first_name"));
  },
  async listDens() {
    return unwrap(await supabase.from("dens")
      .select("id,den_number,current_rank_working_toward,active")
      .eq("active",true).order("den_number"));
  },
  async save(id,payload) {
    return unwrap(await (id
      ? supabase.from("scouts").update(payload).eq("id",id).select(SCOUT_SELECT).single()
      : supabase.from("scouts").insert(payload).select(SCOUT_SELECT).single()));
  },
  async setPrimaryGuardian(scoutId, guardian) {
    return unwrap(await supabase.rpc("set_scout_primary_guardian", {
      p_scout_id: scoutId,
      p_first_name: guardian.first_name || null,
      p_last_name: guardian.last_name || null,
      p_email: guardian.email || null,
      p_relationship: guardian.relationship || "Parent/Guardian"
    }));
  }
};
