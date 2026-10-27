import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  const userId = '417f227e-e2e6-4bd2-8283-58bb4eb46928';
  const { data: jobs } = await supabase.from('scrape_jobs').select('id, status, created_at').eq('user_id', userId).in('status', ['queued', 'running', 'streaming']);
  console.log('Active scrape_jobs (' + (jobs?.length ?? 0) + '):', jobs);

  const { data: plans } = await supabase.from('discovery_plans').select('id, status, scrape_job_id, created_at').eq('user_id', userId).in('status', ['queued', 'running']);
  console.log('Active discovery_plans (' + (plans?.length ?? 0) + '):', plans);

  const { data: runningTasks } = await supabase.from('discovery_tasks').select('id, plan_id, status, city, created_at, started_at').eq('user_id', userId).eq('status', 'running');
  console.log('Running tasks (' + (runningTasks?.length ?? 0) + '):', runningTasks);
}

run().catch(console.error);
