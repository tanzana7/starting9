import test from "node:test";
import assert from "node:assert/strict";
import { summarizeV3RosterNotice } from "../auth-worker.js";

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
});
