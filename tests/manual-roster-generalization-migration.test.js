import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getManualLineupPlayerCatalog } from "../auth-worker.js";
import { teamContext } from "../backend/target-team.js";
import {
  getManualRoster,
  saveManualRoster
} from "../backend/automation-v3/manual-roster-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationText = (name) => fs.readFileSync(path.join(root, "migrations", name), "utf8");

function databaseBinding(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params),
            run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
          };
        }
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    }
  };
}

test("0050 preserves legacy Fighters rows and enables only canonical team-scoped roster keys", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(migrationText("0036_manual_team_rosters.sql"));
  database.exec(migrationText("0043_manual_team_roster_modes.sql"));
  database.prepare(`INSERT INTO manual_team_rosters
    (team_code, team_id, player_id, status, mode, roster_source, updated_at, updated_by)
    VALUES ('fighters', 'F', 'F-3', 'active', 'active', 'manual', '2026-10-01T00:00:00.000Z', 'admin:legacy')`).run();
  database.exec(migrationText("0050_generalize_manual_team_rosters.sql"));

  assert.deepEqual(database.prepare("SELECT team_code, team_id, player_id, status, mode, updated_by FROM manual_team_rosters").all().map((row) => ({ ...row })), [
    { team_code: "fighters", team_id: "F", player_id: "F-3", status: "active", mode: "active", updated_by: "admin:legacy" }
  ]);
  assert.throws(() => database.prepare(`INSERT INTO manual_team_rosters
    (team_code, team_id, player_id, status, roster_source, updated_at, updated_by)
    VALUES ('marines', 'F', 'bad-cross-team', 'active', 'manual', 'now', 'admin:test')`).run(), /CHECK constraint failed/);
  database.prepare(`INSERT INTO manual_team_rosters
    (team_code, team_id, player_id, status, mode, roster_source, updated_at, updated_by)
    VALUES ('marines', 'M', 'M-3', 'active', 'active', 'manual', 'now', 'admin:test')`).run();
  database.prepare(`INSERT INTO manual_team_rosters
    (team_code, team_id, player_id, status, mode, roster_source, updated_at, updated_by)
    VALUES ('tigers', 'T', 'T-3', 'active', 'active', 'manual', 'now', 'admin:test')`).run();
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_manual_team_rosters_%' ORDER BY name").all().map((row) => row.name), [
    "idx_manual_team_rosters_mode",
    "idx_manual_team_rosters_status"
  ]);

  const db = databaseBinding(database);
  for (const [teamKey, teamId] of [["fighters", "F"], ["marines", "M"], ["tigers", "T"], ["hawks", "H"]]) {
    const catalog = getManualLineupPlayerCatalog({
      targetTeam: teamContext.NPB_TEAMS[teamKey],
      rosterPlayers: teamKey === "fighters" ? null : [{ playerId: "npb:12345678", name: `${teamKey} batter`, number: "8", position: "外野手" }]
    });
    const player = catalog.find((entry) => entry.manualRosterEligible);
    assert.ok(player, `${teamKey} has a scoped candidate`);
    await saveManualRoster(db, { teamCode: teamKey, entries: [{ playerId: player.playerId, mode: "active" }], updatedBy: "admin:test", catalog });
    assert.equal((await getManualRoster(db, { teamCode: teamKey })).entries.some((entry) => entry.playerId === player.playerId), true);
    assert.equal((await getManualRoster(db, { teamCode: teamKey })).team.teamId, teamId);
  }
  assert.equal((await getManualRoster(db, { teamCode: "fighters" })).entries.some((entry) => entry.playerId === "F-3"), true);
  assert.deepEqual(getManualLineupPlayerCatalog({ targetTeam: teamContext.NPB_TEAMS.marines }), []);
  database.close();
});
