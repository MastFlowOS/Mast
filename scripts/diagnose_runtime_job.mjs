import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const envText = fs.readFileSync(".env", "utf8");
function getEnv(name) {
  const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

const url = getEnv("SUPABASE_URL");
const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log("=== 1. FETCH LATEST 5 SCRAPE JOBS ===");
  const { data: jobs, error: jobsErr } = await supabase
    .from("scrape_jobs")
    .select("id, user_id, mode, status, query, results_count, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  if (jobsErr) {
    console.error("Error fetching scrape_jobs:", jobsErr.message);
    return;
  }

  console.log(`Found ${jobs?.length ?? 0} jobs:`);
  for (const job of jobs || []) {
    console.log({
      id: job.id,
      mode: job.mode,
      status: job.status,
      results_count: job.results_count,
      created_at: job.created_at,
      execution_target: job.query?.execution_target,
      niche: job.query?.niche,
      region: job.query?.region,
      quantity: job.query?.quantity,
    });
  }

  if (!jobs || jobs.length === 0) {
    console.log("No jobs found.");
    return;
  }

  const latestJob = jobs[0];
  console.log(`\n=== 2. DETAILS FOR LATEST JOB ${latestJob.id} ===`);
  console.log("Full query object:", JSON.stringify(latestJob.query, null, 2));

  // Query discovery_plans for this job
  const { data: plans, error: plansErr } = await supabase
    .from("discovery_plans")
    .select("*")
    .eq("scrape_job_id", latestJob.id);

  if (plansErr) {
    console.error("Error fetching discovery_plans:", plansErr.message);
  } else {
    console.log(`Plans count for job: ${plans?.length ?? 0}`);
    for (const plan of plans || []) {
      console.log({
        id: plan.id,
        user_id: plan.user_id,
        status: plan.status,
        niche: plan.niche,
        region: plan.region,
        requested_count: plan.requested_count,
        delivered_count: plan.delivered_count,
        created_at: plan.created_at,
        started_at: plan.started_at,
        completed_at: plan.completed_at,
      });

      // Query discovery_tasks for this plan
      const { data: tasks, error: tasksErr } = await supabase
        .from("discovery_tasks")
        .select("*")
        .eq("plan_id", plan.id);

      if (tasksErr) {
        console.error("Error fetching discovery_tasks:", tasksErr.message);
      } else {
        console.log(`  Tasks count for plan: ${tasks?.length ?? 0}`);
        for (const task of tasks || []) {
          // Sanitize: do not print lease token
          const summary = task.task_summary ? { ...task.task_summary } : {};
          if (summary.lease_token) {
            summary.lease_token = "[PRESENT - REDACTED]";
          }
          console.log({
            id: task.id,
            city: task.city,
            country_code: task.country_code,
            niche: task.niche,
            status: task.status,
            discovered_count: task.discovered_count,
            accepted_count: task.accepted_count,
            rejected_count: task.rejected_count,
            started_at: task.started_at,
            completed_at: task.completed_at,
            last_heartbeat_at: task.last_heartbeat_at,
            execution_target_column: task.execution_target,
            task_summary: summary,
          });
        }
      }
    }
  }

  // Check leads
  const { data: leads, error: leadsErr } = await supabase
    .from("leads")
    .select("id, name, city, website, created_at")
    .eq("scrape_job_id", latestJob.id);

  if (leadsErr) {
    console.error("Error fetching leads:", leadsErr.message);
  } else {
    console.log(`\nDelivered Leads (${leads?.length ?? 0}):`);
    for (const lead of leads || []) {
      console.log(`- ${lead.name} (${lead.city}) [${lead.created_at}]`);
    }
  }

  // Check discovery_live_events
  const { data: events, error: eventsErr } = await supabase
    .from("discovery_live_events")
    .select("*")
    .eq("job_id", latestJob.id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (eventsErr) {
    console.error("Error fetching discovery_live_events:", eventsErr.message);
  } else {
    console.log(`\nRecent live events (${events?.length ?? 0}):`);
    for (const ev of events || []) {
      console.log(`[${ev.created_at}] ${ev.event_type}:`, JSON.stringify(ev.payload || ev.event_data || ev));
    }
  }

  // Check worker_instances
  const { data: workers, error: workersErr } = await supabase
    .from("worker_instances")
    .select("id, pool_type, effective_concurrency, last_heartbeat_at, started_at")
    .order("last_heartbeat_at", { ascending: false })
    .limit(10);

  if (workersErr) {
    console.error("Error fetching worker_instances:", workersErr.message);
  } else {
    console.log(`\nActive / Recent Worker Instances (${workers?.length ?? 0}):`);
    for (const w of workers || []) {
      console.log(w);
    }
  }
}

run().catch(console.error);
