import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: bizes } = await supabase
    .from("businesses")
    .select("name, website, phone, email, instagram, address, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  console.log("Recent Businesses in DB:");
  bizes?.forEach((b, i) => {
    console.log(`${i+1}. [${b.name}] web=${b.website} phone=${b.phone} email=${b.email} ig=${b.instagram} at=${b.created_at}`);
  });
}

main().catch(console.error);
