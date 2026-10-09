    await boss.schedule(QUEUES.staleScrapeJobSweep, "*/5 * * * *", {});
  } catch (err) {
    console.error("[worker] Optional scheduler failed to schedule stale-scrape-job-sweep (non-fatal):", err);
  }

  await boss.work(QUEUES.staleScrapeJobSweep, async () => {
    try {
      await sweepStaleScrapeJobs();
    } catch (err) {
      console.error("[worker] Background stale-scrape-job-sweep failed (non-fatal):", err);
    }
  });

  // Durable task rows may outlive their pg-boss jobs after retry exhaustion.
  // Re-dispatch only the known transient PID-admission failures; singletonKey
  // prevents duplicate queued/active jobs while this sweep repeats.
  let businessTaskRecoveryRunning = false;
  const sweepBusinessProcessingTasks = async () => {
    if (businessTaskRecoveryRunning) return;
    businessTaskRecoveryRunning = true;
    try {
      const result = await requeueAdmissionBlockedBusinessTasks();
      if (result.candidates > 0) {
        console.log(
          `[worker][business-task-recovery] candidates=${result.candidates} newly_enqueued=${result.enqueued}`,
        );
      }
    } catch (err) {
      console.warn("[worker] business processing task recovery failed (non-fatal):", err);
    } finally {
      businessTaskRecoveryRunning = false;
    }
  };
  void sweepBusinessProcessingTasks();
  businessTaskRecoveryInterval = setInterval(
    () => { void sweepBusinessProcessingTasks(); },
    60_000,
  );
  businessTaskRecoveryInterval.unref();

  console.log(`[worker] subscribed to all queues — effectiveConcurrency=${browserCapacity.effectiveConcurrency} configured=${browserCapacity.configuredConcurrency} freeMb=${browserCapacity.freeMemoryMb}`);
}

async function runJob(bossJobId: string, scrapeJobId: string | null, fn: () => Promise<void>) {
  if (scrapeJobId) {
    // Only transition to 'running' if the job is in an appropriate pre-run
    // state. Do NOT overwrite 'cancelled' (set by the user before we even
    // started) or any terminal state left by a previous crashed attempt.
    await supabaseAdmin.from("scrape_jobs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", scrapeJobId)