import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  const planId = process.argv[2] || '8a38363a-03aa-4a45-bbef-11bc424c702b';
  const jobId = process.argv[3] || '15eacfdc-9a22-4c8c-ae6d-4acb6fa67389';

  const { data: plan } = await supabase.from('discovery_plans').select('*').eq('id', planId).single();
  console.log('Plan:', plan?.id, plan?.status, 'total_tasks:', plan?.total_tasks, 'completed_tasks:', plan?.completed_tasks, 'target:', plan?.target_leads, 'delivered:', plan?.delivered_leads);

  const { data: tasks } = await supabase.from('discovery_tasks').select('id, status, city, area_name, source, candidate_count, error').eq('plan_id', planId);
  console.log('Tasks (' + (tasks?.length ?? 0) + '):', tasks);

  const { data: job } = await supabase.from('scrape_jobs').select('*').eq('id', jobId).single();
  console.log('Job:', job?.id, job?.status, 'results_count:', job?.results_count, 'error:', job?.error);

  const { data: events } = await supabase.from('discovery_live_events').select('*').eq('plan_id', planId);
  console.log('Events count:', events?.length ?? 0);
  if (events && events.length > 0) {
    for (const ev of events.slice(-10)) {
      console.log('Event:', ev.event_type, ev.business_name, ev.terminal_reason);
    }
  }
}

run().catch(console.error);
