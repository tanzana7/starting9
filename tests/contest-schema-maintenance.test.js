import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../auth-worker.js";
import { inspectContestSchemaReadiness } from "../backend/contest-schema-readiness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationFiles = fs.readdirSync(path.join(root, "migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();

function createDatabase(through = "0049") {
  const database = new DatabaseSync(":memory:");
  for (const filename of migrationFiles) {
    if (filename.slice(0, 4) > through) break;
    database.exec(fs.readFileSync(path.join(root, "migrations", filename), "utf8"));
  }
  return database;
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        first: async () => statement.get(),
        all: async () => ({ results: statement.all() }),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind(...values) {
          return {
            first: async () => statement.get(...values),
            all: async () => ({ results: statement.all(...values) }),
            run: async () => ({ meta: { changes: Number(statement.run(...values).changes || 0) } })
          };
        }
      };
    }
  };
}

function apiRequest(pathname) {
  return new Request(`https://starting9.test${pathname}`, {
    headers: { Origin: "https://starting9.test" }
  });
}

test("old schema health remains 200 and business APIs return controlled 503", async (t) => {
  const database = createDatabase("0045");
  t.after(() => database.close());
  const env = { AUTH_DB: d1(database), AUTH_ALLOWED_ORIGINS: "https://starting9.test", REQUIRE_CONTEST_SCHEMA: "true" };

  const health = await worker.fetch(apiRequest("/health"), env, {});
  assert.equal(health.status, 200);
  assert.deepEqual(
    (({ schemaReady, maintenance, reasonCode }) => ({ schemaReady, maintenance, reasonCode }))(await health.json()),
    { schemaReady: false, maintenance: true, reasonCode: "SCHEMA_MIGRATION_REQUIRED" }
  );

  const response = await worker.fetch(apiRequest("/api/public/games"), env, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SCHEMA_MIGRATION_REQUIRED");
});

test("partial 0046, 0047, or 0048 schemas remain fail-closed", async (t) => {
  for (const through of ["0046", "0047", "0048"]) {
    const database = createDatabase(through);
    t.after(() => database.close());
    const readiness = await inspectContestSchemaReadiness(d1(database));
    assert.equal(readiness.ready, false, `schema through ${through}`);
    const response = await worker.fetch(apiRequest("/api/public/games"), {
      AUTH_DB: d1(database),
      AUTH_ALLOWED_ORIGINS: "https://starting9.test",
      REQUIRE_CONTEST_SCHEMA: "true"
    }, {});
    assert.equal(response.status, 503, `schema through ${through}`);
    assert.equal((await response.json()).code, "SCHEMA_MIGRATION_REQUIRED");
  }
});

test("full contest schema resumes automatically and exposes readiness", async (t) => {
  const database = createDatabase("0049");
  t.after(() => database.close());
  const env = { AUTH_DB: d1(database), AUTH_ALLOWED_ORIGINS: "https://starting9.test", REQUIRE_CONTEST_SCHEMA: "true" };
  assert.equal((await inspectContestSchemaReadiness(env.AUTH_DB)).ready, true);
  const health = await worker.fetch(apiRequest("/health"), env, {});
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.schemaReady, true);
  assert.equal(payload.maintenance, false);

  const response = await worker.fetch(apiRequest("/api/public/games"), env, {});
  assert.notEqual(response.status, 503);
});

test("full contest schema readiness batches column probes for D1 compound-select limits", async (t) => {
  const database = createDatabase("0049");
  t.after(() => database.close());
  const localD1 = d1(database);
  const d1WithCompoundSelectLimit = {
    prepare(sql) {
      const terms = String(sql).split(/\bUNION\s+ALL\b/i).length;
      if (terms > 5) throw new Error("too many terms in compound SELECT: SQLITE_ERROR");
      return localD1.prepare(sql);
    }
  };
  assert.equal((await inspectContestSchemaReadiness(d1WithCompoundSelectLimit)).ready, true);
});

test("migration ledger, when present, must contain all four C-4 migrations", async (t) => {
  const database = createDatabase("0049");
  t.after(() => database.close());
  database.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const name of migrationFiles.filter((filename) => /^004[6-9]_/.test(filename) && filename !== "0049_contest_scoped_formal_jobs.sql")) {
    database.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
  }
  const partialLedger = await inspectContestSchemaReadiness(d1(database));
  assert.equal(partialLedger.ready, false);
  assert.deepEqual(partialLedger.missingMigrations, ["0049_contest_scoped_formal_jobs.sql"]);

  database.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)")
    .run("0049_contest_scoped_formal_jobs.sql", new Date().toISOString());
  assert.equal((await inspectContestSchemaReadiness(d1(database))).ready, true);
});

test("a missing contest identity index or trigger fails closed", async (t) => {
  const database = createDatabase("0049");
  t.after(() => database.close());
  database.exec("DROP INDEX idx_game_jobs_v3_contest_identity");
  const missingIndex = await inspectContestSchemaReadiness(d1(database));
  assert.equal(missingIndex.ready, false);
  assert.ok(missingIndex.missingIndexes.includes("idx_game_jobs_v3_contest_identity"));

  database.exec("CREATE UNIQUE INDEX idx_game_jobs_v3_contest_identity ON game_jobs_v3(contest_id, job_type, scheduled_slot_at) WHERE contest_id IS NOT NULL");
  database.exec("DROP TRIGGER predictions_require_contest_insert");
  const missingTrigger = await inspectContestSchemaReadiness(d1(database));
  assert.equal(missingTrigger.ready, false);
  assert.ok(missingTrigger.missingTriggers.includes("predictions_require_contest_insert"));
});

test("old-schema scheduled event skips before heartbeat, planner, or job writes", async (t) => {
  const database = createDatabase("0045");
  t.after(() => database.close());
  let waitUntilCalls = 0;
  const result = await worker.scheduled(
    { cron: "* * * * *", scheduledTime: Date.now() },
    { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true", REQUIRE_CONTEST_SCHEMA: "true" },
    { waitUntil() { waitUntilCalls += 1; } }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reasonCode, "SCHEMA_MIGRATION_REQUIRED");
  assert.equal(waitUntilCalls, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_state").get().count, 0);
});
