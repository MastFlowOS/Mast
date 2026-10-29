import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: bizes } = await supabase
    .from("businesses")
    .select("id, name, email, phone, website, instagram, emails, phones, signals, field_provenance")
    .in("name", [
      "Dollop Coffee Co.",
      "Ralph's Coffee",
      "Urban Luxe Cafe",
      "Sip & Savor | 53rd Street - Hyde Park",
      "Cafe Deko",
      "Base Community Cafe"
    ]);

  console.log(JSON.stringify(bizes, null, 2));
}

main().catch(console.error);
