import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  const userId = '417f227e-e2e6-4bd2-8283-58bb4eb46928';

  // 1. Cancel all non-terminal discovery_tasks for this user
  const { data: updatedTasks, error: taskErr } = await supabase
    .from('discovery_tasks')
    .update({
      status: 'cancelled',
      termination_reason: 'USER_CANCELLED',
      completed_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .select('id, city, status');
  console.log('Cancelled tasks:', updatedTasks?.length ?? 0, taskErr ?? '');

  // 2. Cancel all non-terminal discovery_plans for this user
  const { data: updatedPlans, error: planErr } = await supabase
    .from('discovery_plans')
    .update({
      status: 'cancelled',
      terminal_reason: 'USER_CANCELLED',
      completed_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .select('id, status');
  console.log('Cancelled plans:', updatedPlans?.length ?? 0, planErr ?? '');

  // 3. Cancel all non-terminal scrape_jobs for this user
  const { data: updatedJobs, error: jobErr } = await supabase
    .from('scrape_jobs')
    .update({
      status: 'cancelled',
      completed_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .in('status', ['queued', 'running', 'streaming'])
    .select('id, status');
  console.log('Cancelled jobs:', updatedJobs?.length ?? 0, jobErr ?? '');
}

run().catch(console.error);
