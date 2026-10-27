import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: bizes } = await supabase
    .from("businesses")
    .select("name, website, phone, email, instagram, enrichment_status, raw_data")
    .ilike("name", "%October Cafe%")
    .limit(5);

  console.log(JSON.stringify(bizes, null, 2));
}

main().catch(console.error);
