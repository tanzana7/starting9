import test from "node:test";
import assert from "node:assert/strict";
import { summarizeV3RosterNotice, validateV3RosterAnnouncement } from "../auth-worker.js";
import { getV3RosterPlanningDiagnostics } from "../game-automation-v3.js";

const roster = [{ number: "1", name: "選手", position: "投手" }];

test("V3 rosterは両対象球団の公式公示を確認し、変更なしを成功として区別する", () => {
  const result = summarizeV3RosterNotice({
    pageDate: "2026-08-08",
    rosters: { "北海道日本ハムファイターズ": roster, "東北楽天ゴールデンイーグルス": roster },
    registrations: [],
    removals: []
  }, { gameDate: "2026-08-08", homeTeam: "fighters", awayTeam: "eagles" });
  assert.equal(result.homeRosterConfirmed, true);
  assert.equal(result.awayRosterConfirmed, true);
  assert.equal(result.noticeState, "ROSTER_NO_CHANGES");
  assert.equal(result.totalRosterChanges, 0);
  assert.deepEqual(validateV3RosterAnnouncement(result, { gameDate: "2026-08-08" }), {
    ok: true,
    code: "ROSTER_NO_CHANGES",
    parserResult: "valid"
  });
});

test("V3 rosterは相手球団の登録・抹消も監査し、対象外日を成功扱いにしない", () => {
  const result = summarizeV3RosterNotice({
    pageDate: "2026-08-07",
    rosters: { fighters: roster, eagles: roster },
    registrations: [{ team: "楽天", name: "選手A" }],
    removals: [{ team: "E", name: "選手B" }]
  }, { gameDate: "2026-08-08", homeTeam: "fighters", awayTeam: "eagles" });
  assert.equal(result.registeredCountAway, 1);
  assert.equal(result.deregisteredCountAway, 1);
  assert.equal(result.totalRosterChanges, 2);
  assert.equal(result.noticeState, "ROSTER_NOTICE_DATE_UNAVAILABLE");
  assert.deepEqual(result.registeredPlayersAway, ["選手A"]);
  assert.deepEqual(result.deregisteredPlayersAway, ["選手B"]);
  assert.deepEqual(validateV3RosterAnnouncement(result, { gameDate: "2026-08-08" }), {
    ok: false,
    code: "ROSTER_SOURCE_DATE_MISMATCH",
    parserResult: "notice_date_mismatch"
  });
});

test("V3 rosterは片方の球団確認が欠けた公示を成功判定に使わない", () => {
  const result = summarizeV3RosterNotice({
    pageDate: "2026-08-08",
    rosters: { fighters: roster },
    registrations: [],
    removals: []
  }, { gameDate: "2026-08-08", homeTeam: "fighters", awayTeam: "eagles" });
  assert.equal(result.homeRosterConfirmed, true);
  assert.equal(result.awayRosterConfirmed, false);
  assert.deepEqual(validateV3RosterAnnouncement(result, { gameDate: "2026-08-08" }), {
    ok: false,
    code: "ROSTER_TEAM_MISMATCH",
    parserResult: "team_confirmation_failed"
  });
});

test("V3 rosterのplanner診断は当日slotと最新の期限到達slotを共通契約で返す", () => {
  const diagnostics = getV3RosterPlanningDiagnostics({
    gameDate: "2026-08-08",
    startAt: "2026-08-08T06:00:00.000Z"
  }, "2026-08-08T04:20:00.000Z");
  assert.deepEqual(diagnostics.generatedSlots, [
    "2026-08-08T04:00:00.000Z",
    "2026-08-08T04:10:00.000Z",
    "2026-08-08T07:02:00.000Z",
    "2026-08-08T07:10:00.000Z"
  ]);
  assert.equal(diagnostics.selectedDueSlot, "2026-08-08T04:10:00.000Z");
  assert.equal(diagnostics.selectedSlotReason, "latest_due_roster_slot");
});
