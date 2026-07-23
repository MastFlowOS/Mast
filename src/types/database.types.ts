/**
 * Hand-maintained equivalent of `supabase gen types typescript`, built by
 * reading every file in `migrations/` end-to-end (001 through 013) rather
 * than from a live `supabase gen types` run — this environment has no
 * network path to the Supabase Management API, so this is the closest
 * available substitute. Regenerate for real (`supabase gen types typescript
 * --project-id <ref> > src/types/database.types.ts`) the next time CI or a
 * dev machine has access, and prefer that output over hand-maintaining this
 * file further.
 *
 * Coverage note: `professions`, `businesses`, `business_opportunity_scores`,
 * `business_opportunity_insights`, `business_health_scores`,
 * `ai_intelligence`, `scrape_jobs`, `lead_activities`, and
 * `business_processing_tasks` are fully and unambiguously defined by
 * `create table` statements in the migrations above — those Row/Insert/
 * Update shapes here are authoritative.
 *
 * `profiles` and `leads` are the exception: per migrations/011's own root
 * cause note, both tables predate every migration in this repo (restored
 * from an external pg_dump, never created by a `CREATE TABLE` this history
 * has ever seen) — migrations 001/002/008/013 only show `ALTER TABLE ADD
 * COLUMN` statements for a handful of columns each. The Row types below for
 * these two tables reflect every column actually referenced across
 * `src/server`, `src/lib`, `src/jobs`, `src/scraperBridge`, and
 * `src/scoring` (i.e. everything `tsconfig.server.json` compiles) — not
 * necessarily their complete real-world schema. Treat unlisted columns on
 * `profiles`/`leads` as unknown-to-this-file, not nonexistent.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      professions: {
        Row: {
          slug: string;
          label: string;
        };
        Insert: {
          slug: string;
          label: string;
        };
        Update: {
          slug?: string;
          label?: string;
        };
        Relationships: [];
      };

      businesses: {
        Row: {
          id: string;
          place_id: string | null;
          normalized_name: string | null;
          normalized_phone: string | null;
          domain: string | null;
          name: string;
          category: string | null;
          niche: string | null;
          query_used: string | null;
          region: string | null;
          address: string | null;
          lat: number | null;
          lng: number | null;
          website: string | null;
          email: string | null;
          phone: string | null;
          instagram: string | null;
          facebook: string | null;
          linkedin: string | null;
          reviews_count: number | null;
          reviews_rating: number | null;
          has_photos: boolean | null;
          signals: Json;
          raw_data: Json | null;
          first_discovered_at: string;
          last_verified_at: string;
          verification_due_at: string;
          is_disqualified: boolean;
          disqualify_reason: string | null;
          fingerprints: string[];
          confidence: number;
          archived_at: string | null;
          archived_reason: string | null;
          last_verification_kind: string | null;
          emails: Json;
          phones: Json;
          field_provenance: Json;
          website_is_weak: boolean | null;
          ssl_valid: boolean | null;
          load_time_ms: number | null;
          seo: Json;
          blog: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          place_id?: string | null;
          normalized_name?: string | null;
          normalized_phone?: string | null;
          domain?: string | null;
          name: string;
          category?: string | null;
          niche?: string | null;
          query_used?: string | null;
          region?: string | null;
          address?: string | null;
          lat?: number | null;
          lng?: number | null;
          website?: string | null;
          email?: string | null;
          phone?: string | null;
          instagram?: string | null;
          facebook?: string | null;
          linkedin?: string | null;
          reviews_count?: number | null;
          reviews_rating?: number | null;
          has_photos?: boolean | null;
          signals?: Json;
          raw_data?: Json | null;
          first_discovered_at?: string;
          last_verified_at?: string;
          verification_due_at?: string;
          is_disqualified?: boolean;
          disqualify_reason?: string | null;
          fingerprints?: string[];
          confidence?: number;
          archived_at?: string | null;
          archived_reason?: string | null;
          last_verification_kind?: string | null;
          emails?: Json;
          phones?: Json;
          field_provenance?: Json;
          website_is_weak?: boolean | null;
          ssl_valid?: boolean | null;
          load_time_ms?: number | null;
          seo?: Json;
          blog?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          place_id?: string | null;
          normalized_name?: string | null;
          normalized_phone?: string | null;
          domain?: string | null;
          name?: string;
          category?: string | null;
          niche?: string | null;
          query_used?: string | null;
          region?: string | null;
          address?: string | null;
          lat?: number | null;
          lng?: number | null;
          website?: string | null;
          email?: string | null;
          phone?: string | null;
          instagram?: string | null;
          facebook?: string | null;
          linkedin?: string | null;
          reviews_count?: number | null;
          reviews_rating?: number | null;
          has_photos?: boolean | null;
          signals?: Json;
          raw_data?: Json | null;
          first_discovered_at?: string;
          last_verified_at?: string;
          verification_due_at?: string;
          is_disqualified?: boolean;
          disqualify_reason?: string | null;
          fingerprints?: string[];
          confidence?: number;
          archived_at?: string | null;
          archived_reason?: string | null;
          last_verification_kind?: string | null;
          emails?: Json;
          phones?: Json;
          field_provenance?: Json;
          website_is_weak?: boolean | null;
          ssl_valid?: boolean | null;
          load_time_ms?: number | null;
          seo?: Json;
          blog?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      business_opportunity_scores: {
        Row: {
          business_id: string;
          profession_slug: string;
          opportunity_score: number;
          score_breakdown: Json;
          computed_at: string;
        };
        Insert: {
          business_id: string;
          profession_slug: string;
          opportunity_score: number;
          score_breakdown?: Json;
          computed_at?: string;
        };
        Update: {
          business_id?: string;
          profession_slug?: string;
          opportunity_score?: number;
          score_breakdown?: Json;
          computed_at?: string;
        };
        Relationships: [];
      };

      business_opportunity_insights: {
        Row: {
          business_id: string;
          profession_slug: string;
          headline: string;
          talking_points: Json;
          opening_line: string;
          score_snapshot: number;
          model: string;
          generated_at: string;
        };
        Insert: {
          business_id: string;
          profession_slug: string;
          headline: string;
          talking_points: Json;
          opening_line: string;
          score_snapshot: number;
          model: string;
          generated_at?: string;
        };
        Update: {
          business_id?: string;
          profession_slug?: string;
          headline?: string;
          talking_points?: Json;
          opening_line?: string;
          score_snapshot?: number;
          model?: string;
          generated_at?: string;
        };
        Relationships: [];
      };

      business_health_scores: {
        Row: {
          business_id: string;
          health_score: number;
          breakdown: Json;
          computed_at: string;
        };
        Insert: {
          business_id: string;
          health_score: number;
          breakdown?: Json;
          computed_at?: string;
        };
        Update: {
          business_id?: string;
          health_score?: number;
          breakdown?: Json;
          computed_at?: string;
        };
        Relationships: [];
      };

      ai_intelligence: {
        Row: {
          id: string;
          user_id: string;
          kind: string;
          period_key: string;
          content: Json;
          model: string;
          generated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: string;
          period_key: string;
          content: Json;
          model: string;
          generated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: string;
          period_key?: string;
          content?: Json;
          model?: string;
          generated_at?: string;
        };
        Relationships: [];
      };

      scrape_jobs: {
        Row: {
          id: string;
          user_id: string | null;
          mode: "live" | "instant_pool" | "instant_pool_ranked" | "background_expand" | "verification";
          status: "queued" | "running" | "streaming" | "completed" | "completed_partial" | "failed" | "cancelled";
          query: Json;
          results_count: number;
          error: string | null;
          created_at: string;
          started_at: string | null;
          completed_at: string | null;
          job_summary: Json | null;
          // AUDIT FIX (Verification Report, Finding 6): heartbeat pulsed by
          // poolExpandJob while status='streaming'; read by
          // jobs/staleScrapeJobSweep.ts to reclaim crashed runs. See
          // migrations/020_scrape_jobs_heartbeat.sql.
          last_heartbeat_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          mode: "live" | "instant_pool" | "instant_pool_ranked" | "background_expand" | "verification";
          status?: "queued" | "running" | "streaming" | "completed" | "completed_partial" | "failed" | "cancelled";
          query: Json;
          results_count?: number;
          error?: string | null;
          created_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
          job_summary?: Json | null;
          last_heartbeat_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          mode?: "live" | "instant_pool" | "instant_pool_ranked" | "background_expand" | "verification";
          status?: "queued" | "running" | "streaming" | "completed" | "completed_partial" | "failed" | "cancelled";
          query?: Json;
          results_count?: number;
          error?: string | null;
          created_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
          job_summary?: Json | null;
          last_heartbeat_at?: string | null;
        };
        Relationships: [];
      };

      lead_activities: {
        Row: {
          id: string;
          lead_id: number;
          user_id: string;
          type: string;
          timestamp: string;
          content: string;
          channel: string | null;
          subject: string | null;
          body: string | null;
          metadata: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: number;
          user_id: string;
          type: string;
          timestamp?: string;
          content: string;
          channel?: string | null;
          subject?: string | null;
          body?: string | null;
          metadata?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          lead_id?: number;
          user_id?: string;
          type?: string;
          timestamp?: string;
          content?: string;
          channel?: string | null;
          subject?: string | null;
          body?: string | null;
          metadata?: Json | null;
          created_at?: string;
        };
        Relationships: [];
      };

      /**
       * Durable enrich/score wake-up ledger — see migrations/015 and
       * src/jobs/businessProcessingJob.ts. `kind`/`status` are narrowed to
       * their actual check-constraint values rather than left as bare
       * `string` so a typo'd status string errors at compile time instead
       * of silently never matching in a `.eq("status", ...)` filter.
       */
      business_processing_tasks: {
        Row: {
          id: string;
          business_id: string;
          kind: "enrich" | "score";
          status: "queued" | "running" | "completed" | "failed";
          attempts: number;
          error: string | null;
          created_at: string;
          started_at: string | null;
          completed_at: string | null;
          last_heartbeat_at: string | null;
        };
        Insert: {
          id?: string;
          business_id: string;
          kind: "enrich" | "score";
          status?: "queued" | "running" | "completed" | "failed";
          attempts?: number;
          error?: string | null;
          created_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
          last_heartbeat_at?: string | null;
        };
        Update: {
          id?: string;
          business_id?: string;
          kind?: "enrich" | "score";
          status?: "queued" | "running" | "completed" | "failed";
          attempts?: number;
          error?: string | null;
          created_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
          last_heartbeat_at?: string | null;
        };
        Relationships: [];
      };

      /**
       * Predates every migration (see file header). Only columns actually
       * read/written by the server build (tsconfig.server.json) are typed;
       * `[key: string]: unknown` intentionally left OFF so a typo'd column
       * name still errors — extend this Row/Insert/Update pair when a new
       * column is genuinely needed rather than reaching for a cast.
       */
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          email: string | null;
          subscription_plan: string | null;
          subscription_status: string | null;
          daily_leads_used: number | null;
          monthly_leads_used: number | null;
          next_daily_reset: string | null;
          next_monthly_reset: string | null;
          pending_plan_change: string | null;
          settings: Json | null;
          xp: number;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          email?: string | null;
          subscription_plan?: string | null;
          subscription_status?: string | null;
          daily_leads_used?: number | null;
          monthly_leads_used?: number | null;
          next_daily_reset?: string | null;
          next_monthly_reset?: string | null;
          pending_plan_change?: string | null;
          settings?: Json | null;
          xp?: number;
        };
        Update: {
          id?: string;
          full_name?: string | null;
          email?: string | null;
          subscription_plan?: string | null;
          subscription_status?: string | null;
          daily_leads_used?: number | null;
          monthly_leads_used?: number | null;
          next_daily_reset?: string | null;
          next_monthly_reset?: string | null;
          pending_plan_change?: string | null;
          settings?: Json | null;
          xp?: number;
        };
        Relationships: [];
      };

      /**
       * Predates every migration (see file header). `id` is bigint
       * (lead_activities.lead_id references it as `bigint`) — modeled as
       * `number` the same way the rest of this codebase already treats it
       * (see dbRowToLead in src/lib/api.ts). Only columns the server build
       * actually touches are typed; see the `profiles` comment above for
       * why unlisted columns are deliberately left off rather than
       * widened.
       */
      leads: {
        Row: {
          id: number;
          user_id: string | null;
          business_id: string | null;
          profession_slug: string | null;
          opportunity_score: number | null;
          discovery_mode: string | null;
          scrape_job_id: string | null;
          credit_charged: boolean;
          business_name: string;
          instagram_handle: string | null;
          linkedin_handle: string | null;
          email: string | null;
          website: string | null;
          phone: string | null;
          niche: string | null;
          location: string | null;
          status: string;
          priority: string | null;
          ig_followers: string | null;
          ig_bio: string | null;
          ig_last_post: string | null;
          source: string | null;
          created_at: string;
          updated_at: string;
          last_contacted_at: string | null;
          follow_up_at: string | null;
        };
        Insert: {
          id?: number;
          user_id?: string | null;
          business_id?: string | null;
          profession_slug?: string | null;
          opportunity_score?: number | null;
          discovery_mode?: string | null;
          scrape_job_id?: string | null;
          credit_charged?: boolean;
          business_name: string;
          instagram_handle?: string | null;
          linkedin_handle?: string | null;
          email?: string | null;
          website?: string | null;
          phone?: string | null;
          niche?: string | null;
          location?: string | null;
          status?: string;
          priority?: string | null;
          ig_followers?: string | null;
          ig_bio?: string | null;
          ig_last_post?: string | null;
          source?: string | null;
          created_at?: string;
          updated_at?: string;
          last_contacted_at?: string | null;
          follow_up_at?: string | null;
        };
        Update: {
          id?: number;
          user_id?: string | null;
          business_id?: string | null;
          profession_slug?: string | null;
          opportunity_score?: number | null;
          discovery_mode?: string | null;
          scrape_job_id?: string | null;
          credit_charged?: boolean;
          business_name?: string;
          instagram_handle?: string | null;
          linkedin_handle?: string | null;
          email?: string | null;
          website?: string | null;
          phone?: string | null;
          niche?: string | null;
          location?: string | null;
          status?: string;
          priority?: string | null;
          ig_followers?: string | null;
          ig_bio?: string | null;
          ig_last_post?: string | null;
          source?: string | null;
          created_at?: string;
          updated_at?: string;
          last_contacted_at?: string | null;
          follow_up_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      try_increment_lead_usage: {
        Args: {
          p_user_id: string;
          p_daily_limit: number;
          p_monthly_limit: number;
          p_count?: number;
        };
        Returns: {
          allowed: boolean;
          subscription_plan: string;
          daily_leads_used: number;
          monthly_leads_used: number;
        }[];
      };
      pool_lookup: {
        Args: {
          p_user_id: string;
          p_region: string;
          p_niche: string;
          p_profession_slug: string | null;
          p_rank: boolean;
          p_limit: number;
        };
        Returns: {
          business_id: string;
          opportunity_score: number | null;
        }[];
      };
      increment_lead_usage: {
        Args: {
          p_user_id: string;
          p_count?: number;
        };
        Returns: undefined;
      };
      award_goal_xp: {
        Args: {
          p_goal_id: string;
          p_completed_on: string;
          p_xp: number;
        };
        Returns: {
          xp: number;
          awarded: boolean;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
