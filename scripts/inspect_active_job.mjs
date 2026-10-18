import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const envText = fs.readFileSync(".env", "utf8");
function getEnv(name) {
  const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

const url = getEnv("SUPABASE_URL");
const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(url, key);

async function run() {
  const { data: jobs, error: err1 } = await supabase
    .from("scrape_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(3);

  if (err1) {
    console.error("Jobs error:", err1.message);
    return;
  }

  console.log("=== LATEST SCRAPE JOBS ===");
  console.log(JSON.stringify(jobs, null, 2));

  if (jobs && jobs.length > 0) {
    const job = jobs[0];
    console.log(`\n=== DETAILS FOR LATEST JOB ${job.id} ===`);

    const { data: tasks, error: err2 } = await supabase
      .from("discovery_tasks")
      .select("*")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false });

    if (err2) console.error("Tasks error:", err2.message);
    else console.log("Tasks count:", tasks.length, "\nTasks:", JSON.stringify(tasks, null, 2));

    const { data: events, error: err3 } = await supabase
      .from("discovery_live_events")
      .select("*")
      .eq("job_id", job.id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (err3) console.error("Events error:", err3.message);
    else console.log("Recent live events count:", events.length, "\nEvents:", JSON.stringify(events, null, 2));
  }
}

run();
