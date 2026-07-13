// Verifies migrations/001_opportunity_engine.sql's professions/leads FK
// against the ACTUAL repo source (src/lib/professions.ts,
// FOCUS_AREA_LABELS + professionSlugForLabel), plus reproduces the old bug
// (the naive slugifyProfession() that used to live in discover.ts /
// intelligence.ts) to prove the failure mode is what we diagnosed and that
// it's now gone.
import pg from "pg";
import { FOCUS_AREA_LABELS, professionSlugForLabel, PROFESSION_SLUGS } from "../src/lib/professions.ts";

// The OLD, buggy generator that used to live in discover.ts and
// intelligence.ts (both now deleted from the actual source — reproduced
// here only to prove what the bug was).
function oldBuggySlugifyProfession(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function main() {
  const client = new pg.Client({
    host: "localhost",
    user: "postgres",
    password: "postgres",
    database: "mast_test",
  });
  await client.connect();

  // sanity: the professions table reflects the real seed from migration 001
  const { rows: seeded } = await client.query("select slug from professions order by slug");
  const seededSlugs = new Set(seeded.map((r) => r.slug as string));
  console.log(`professions table has ${seededSlugs.size} rows`);

  let bugsReproduced = 0;
  let fixedOk = 0;

  for (const label of FOCUS_AREA_LABELS) {
    const oldSlug = oldBuggySlugifyProfession(label);
    const oldSlugExists = seededSlugs.has(oldSlug);

    const newSlug = professionSlugForLabel(label);
    const newSlugExists = newSlug !== null && seededSlugs.has(newSlug);

    const flag = oldSlugExists ? "  " : "!!";
    console.log(
      `${flag} "${label}" -> OLD:"${oldSlug}" (in table: ${oldSlugExists})   NEW:"${newSlug}" (in table: ${newSlugExists})`,
    );

    if (!oldSlugExists) bugsReproduced++;
    if (newSlugExists) fixedOk++;
  }

  console.log(`\n${bugsReproduced}/${FOCUS_AREA_LABELS.length} labels reproduced the OLD FK-violating bug`);
  console.log(`${fixedOk}/${FOCUS_AREA_LABELS.length} labels resolve to a real professions row with the NEW lookup`);

  // Now literally attempt the insert deliverLead.ts's insertLeadForUser()
  // performs (leads.profession_slug references professions(slug)), once
  // with the OLD buggy slug for "Programming & Tech" (must fail with a FK
  // violation, reproducing the reported bug end-to-end), and once with the
  // NEW resolved slug for every focus area (must all succeed).
  const { rows: biz } = await client.query(
    "insert into businesses (name) values ('Acme Software Co') returning id",
  );
  const businessId = biz[0].id as string;

  console.log("\n--- Reproducing the reported bug (POST /v1/discover -> leads insert) ---");
  const badSlug = oldBuggySlugifyProfession("Programming & Tech");
  try {
    await client.query(
      "insert into leads (business_id, profession_slug, business_name) values ($1, $2, $3)",
      [businessId, badSlug, "Acme Software Co"],
    );
    console.log("UNEXPECTED: old slug insert succeeded (bug not reproduced!)");
    process.exitCode = 1;
  } catch (err) {
    const message = (err as Error).message;
    console.log(`Reproduced as expected — insert with profession_slug='${badSlug}' failed:`);
    console.log(`  ${message}`);
    if (!message.includes("foreign key")) {
      console.log("UNEXPECTED failure reason (not the FK violation we expected)");
      process.exitCode = 1;
    }
  }

  console.log("\n--- Verifying the fix: every FOCUS_AREA label now inserts cleanly ---");
  let allInsertsOk = true;
  for (const label of FOCUS_AREA_LABELS) {
    const slug = professionSlugForLabel(label);
    try {
      const { rows } = await client.query(
        "insert into leads (business_id, profession_slug, business_name) values ($1, $2, $3) returning id, profession_slug",
        [businessId, slug, `Lead for ${label}`],
      );
      console.log(`  OK  "${label}" -> profession_slug='${rows[0].profession_slug}' inserted as lead ${rows[0].id}`);
    } catch (err) {
      allInsertsOk = false;
      console.log(`  FAIL "${label}" -> ${(err as Error).message}`);
    }
  }

  const { rows: countRow } = await client.query("select count(*)::int as n from leads");
  console.log(`\nleads table now has ${countRow[0].n} rows (1 rejected-by-design + ${FOCUS_AREA_LABELS.length} successful)`);

  console.log(`\nPROFESSION_SLUGS canonical list size: ${PROFESSION_SLUGS.length} (matches professions table: ${PROFESSION_SLUGS.length === seededSlugs.size})`);

  await client.end();

  if (!allInsertsOk || fixedOk !== FOCUS_AREA_LABELS.length || bugsReproduced === 0) {
    console.error("\nVERIFICATION FAILED");
    process.exit(1);
  }
  console.log("\nVERIFICATION PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
