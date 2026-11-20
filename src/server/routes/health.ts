import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { aiEnabled } from "../../lib/ai.js";
import { isInboxKeyConfigured } from "../../lib/inboxCrypto.js";

export const healthRouter = Router();

export const healthDeps = {
  checkDatabase: async (): Promise<boolean> => {
    try {
      const { error } = await supabaseAdmin.from("profiles").select("id").limit(1);
      return !error;
    } catch {
      return false;
    }
  },
  isAiConfigured: () => aiEnabled(),
  isInboxCryptoConfigured: () => isInboxKeyConfigured(),
};

healthRouter.get("/", async (_req, res) => {
  const database = await healthDeps.checkDatabase();
  const aiConfigured = healthDeps.isAiConfigured();
  const inboxCryptoConfigured = healthDeps.isInboxCryptoConfigured();
  const ok = database;

  res.status(ok ? 200 : 503).json({
    ok,
    service: "mast-opportunity-engine",
    timestamp: new Date().toISOString(),
    checks: {
      api: true,
      database,
      aiConfigured,
      inboxCryptoConfigured,
    },
  });
});
