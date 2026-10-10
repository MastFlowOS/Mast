/**
 * Minimal in-memory stand-in for the parts of `supabaseAdmin` that the lead
 * delivery path touches (businesses, leads, lead_activities and the
 * pool_lookup / try_increment_lead_usage RPCs). It implements just enough of
 * the query-builder chain to run the REAL insertLeadForUser(),
 * upsertBusinessFromEngineLead() and lookupAndDeliverFromPool() code, so the
 * niche tests exercise production code rather than a re-implementation.
 *
 * Not a general Supabase mock: an unsupported table/operation throws, so a
 * production change that starts using a new query shape fails loudly here.
 *
 * Install with `installFakeSupabase(db)`; it patches `from`/`rpc` on the
 * shared client object and returns a restore function.
 */
export type Row = Record<string, any>;

export type RecordedOp = {
  table: string;
  kind: "select" | "insert" | "update" | "delete" | "upsert";
  payload?: Row;
  filters: Array<[string, string, unknown]>;
};

export class FakeDb {
  businesses: Row[] = [];
  leads: Row[] = [];
  lead_activities: Row[] = [];
  /** business_id -> opportunity score, for the ranked (Pro) pool path */
  opportunityScores = new Map<string, number>();
  ops: RecordedOp[] = [];
  rpcCalls: Array<{ fn: string; args: Row }> = [];
  usageAllowed = true;
  /** credits currently consumed — charge (+n) and refund (-n) both move it */
  usageUsed = 0;
  /** optional cap: a charge that would exceed it is rejected (allowed:false) */
  usageCap: number | null = null;
  /** make refund (p_count < 0) calls return an error, to prove leaks surface */
  refundFails = false;
  private seq = 0;

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  mutations(table: string): RecordedOp[] {
    return this.ops.filter((o) => o.table === table && o.kind !== "select");
  }

  private table(name: string): Row[] {
    if (name === "businesses" || name === "leads" || name === "lead_activities") return this[name];
    throw new Error(`FakeDb: unsupported table "${name}"`);
  }

  from(name: string) {
    return new FakeQuery(this, name, this.table(name));
  }

  /** Mirrors migrations/003 + 034 pool_lookup (country-aware). */
  private poolLookup(args: Row): Row[] {
    const has = (hay: unknown, needle: string) =>
      needle === "" || (typeof hay === "string" && hay.toLowerCase().includes(needle.toLowerCase()));
    // Migration 034: continent/Global lookups = legacy label match OR
    // country_code in the set; country lookups (p_country_strict) match ONLY
    // on country_code. NULL country never matches a country set.
    const codes: string[] | null = args.p_country_codes ?? null;
    const inCodes = (b: Row) => codes !== null && b.country_code != null && codes.includes(b.country_code);
    const regionOk = (b: Row) =>
      args.p_country_strict === true ? inCodes(b) : has(b.region ?? "", args.p_region) || inCodes(b);
    const channels: string[] = args.p_channels ?? [];
    const channelOk = (b: Row) => channels.every((channel) => {
      const field = ["email", "phone", "instagram", "website"].includes(channel) ? channel : null;
      return field !== null && typeof b[field] === "string" && b[field].trim().length > 0;
    });
    // Mirrors the SQL left join on (business_id, profession_slug): with no
    // profession slug no score can ever match, so ranking has nothing to use.
    const scoreFor = (id: string): number | null =>
      args.p_profession_slug == null ? null : (this.opportunityScores.get(id) ?? null);
    const matches = this.businesses.filter(
      (b) =>
        b.is_disqualified !== true &&
        regionOk(b) &&
        (args.p_niche === "" || has(b.niche, args.p_niche)) &&
        channelOk(b) &&
        !this.leads.some((l) => l.user_id === args.p_user_id && l.business_id === b.id),
    );
    matches.sort((a, b) => {
      const sa = args.p_rank ? (scoreFor(a.id) ?? -1) : 0;
      const sb = args.p_rank ? (scoreFor(b.id) ?? -1) : 0;
      if (sa !== sb) return sb - sa;
      return String(b.first_discovered_at ?? "").localeCompare(String(a.first_discovered_at ?? ""));
    });
    return matches.slice(0, args.p_limit).map((b) => ({
      business_id: b.id,
      opportunity_score: scoreFor(b.id),
    }));
  }

  rpc(fn: string, args: Row) {
    this.rpcCalls.push({ fn, args });
    let data: unknown;
    let error: { message: string } | null = null;
    if (fn === "pool_lookup") data = this.poolLookup(args);
    else if (fn === "try_increment_lead_usage") {
      const n: number = args.p_count ?? 1;
      if (n < 0) {
        if (this.refundFails) {
          data = null;
          error = { message: "refund failed (simulated)" };
        } else {
          this.usageUsed += n; // refund
          data = { allowed: true };
        }
      } else if (n > 0) {
        const fits = this.usageAllowed && (this.usageCap === null || this.usageUsed + n <= this.usageCap);
        if (fits) this.usageUsed += n;
        data = { allowed: fits };
      } else {
        data = { allowed: this.usageAllowed };
      }
    } else throw new Error(`FakeDb: unsupported rpc "${fn}"`);
    const result = { data, error };
    return Object.assign(Promise.resolve(result), {
      single: () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data, error }),
    });
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private kind: RecordedOp["kind"] = "select";
  private payload?: Row;
  private filters: Array<[string, string, unknown]> = [];
  private limitN: number | null = null;
  private afterInsert = false;

  constructor(
    private db: FakeDb,
    private name: string,
    private rows: Row[],
  ) {}

  select(_cols?: string) {
    return this; // after insert()/update() this just asks for the row back
  }
  insert(row: Row) {
    this.kind = "insert";
    this.payload = row;
    this.afterInsert = true;
    return this;
  }
  update(patch: Row) {
    this.kind = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.kind = "delete";
    return this;
  }
  upsert(row: Row) {
    this.kind = "upsert";
    this.payload = row;
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push([col, "eq", value]);
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push([col, "in", values]);
    return this;
  }
  overlaps(col: string, values: unknown[]) {
    this.filters.push([col, "overlaps", values]);
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matching(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every(([col, op, v]) => {
        if (op === "eq") return r[col] === v;
        if (op === "in") return (v as unknown[]).includes(r[col]);
        if (op === "overlaps") return Array.isArray(r[col]) && (r[col] as unknown[]).some((x) => (v as unknown[]).includes(x));
        throw new Error(`FakeDb: unsupported filter ${op}`);
      }),
    );
  }

  private execute(): { data: Row[] | null; error: { message: string } | null } {
    this.db.ops.push({ table: this.name, kind: this.kind, payload: this.payload, filters: [...this.filters] });
    if (this.kind === "select") {
      const found = this.matching();
      return { data: this.limitN == null ? found : found.slice(0, this.limitN), error: null };
    }
    if (this.kind === "insert") {
      const row = { ...this.payload! };
      if (this.name === "leads" && this.db.leads.some((l) => l.user_id === row.user_id && l.business_id === row.business_id)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint "leads_user_business_key"' } };
      }
      row.id ??= this.db.nextId(this.name);
      this.rows.push(row);
      return { data: [row], error: null };
    }
    if (this.kind === "update") {
      const found = this.matching();
      for (const r of found) Object.assign(r, this.payload);
      return { data: found, error: null };
    }
    throw new Error(`FakeDb: unsupported operation ${this.kind}`);
  }

  maybeSingle() {
    const { data, error } = this.execute();
    return Promise.resolve({ data: data && data.length > 0 ? data[0] : null, error });
  }
  single() {
    return this.maybeSingle();
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

/** Patches `from`/`rpc` on the shared supabaseAdmin client; returns restore(). */
export function installFakeSupabase(client: any, db: FakeDb): () => void {
  const originalFrom = Object.getOwnPropertyDescriptor(client, "from");
  const originalRpc = Object.getOwnPropertyDescriptor(client, "rpc");
  client.from = (name: string) => db.from(name);
  client.rpc = (fn: string, args: Row) => db.rpc(fn, args);
  return () => {
    if (originalFrom) Object.defineProperty(client, "from", originalFrom);
    else delete client.from;
    if (originalRpc) Object.defineProperty(client, "rpc", originalRpc);
    else delete client.rpc;
  };
}