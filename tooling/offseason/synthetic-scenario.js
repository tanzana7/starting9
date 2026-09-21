import { scorePredictionLineup } from "../../backend/domain/scoring.js";

export const OFFSEASON_ENVIRONMENT = Object.freeze({
  pagesProject: "starting9-offseason-test",
  databaseName: "starting9-offseason-test",
  localAuthOrigin: "http://127.0.0.1:8787",
  productionAccess: false,
  productionCredentials: false
});

const TEAM_CODES = Object.freeze([
  "fighters", "hawks", "marines", "eagles", "lions", "buffaloes",
  "swallows", "giants", "tigers", "carp", "dragons", "baystars"
]);

function isoAt(baseAt, offsetMinutes) {
  return new Date(new Date(baseAt).getTime() + offsetMinutes * 60_000).toISOString();
}

function createPlayers(teamCode, teamIndex) {
  return Array.from({ length: 27 }, (_, index) => ({
    playerId: `offseason:${teamCode}:${index + 1}`,
    teamCode,
    number: index + 1,
    name: `${teamCode}-player-${index + 1}`,
    teamIndex
  }));
}

function createActualLineup(players) {
  return players.slice(0, 9).map((player, index) => ({
    playerId: player.playerId,
    name: player.name,
    battingOrder: index + 1,
    position: ["CF", "SS", "2B", "1B", "DH", "RF", "LF", "3B", "C"][index]
  }));
}

function createPrediction(actualLineup, userIndex, gameIndex) {
  // Two exact rows exercise the maximum-score path; the remaining rows use a
  // deterministic rotation so load tests cover non-perfect scoring too.
  if (userIndex % 100 === 0) return actualLineup.map((player) => ({ ...player }));
  const shift = (userIndex + gameIndex) % actualLineup.length;
  return actualLineup.map((player, index) => ({
    ...player,
    playerId: actualLineup[(index + shift) % actualLineup.length].playerId,
    name: actualLineup[(index + shift) % actualLineup.length].name
  }));
}

export function predictionPhase(game, now) {
  const at = new Date(now).getTime();
  const deadline = new Date(game.predictionDeadlineAt).getTime();
  const start = new Date(game.startsAt).getTime();
  if (!Number.isFinite(at)) throw new Error("now must be a valid date");
  if (at < deadline) return "open";
  if (at < start) return "closed";
  return "in_progress";
}

export function createSyntheticScenario({
  baseAt = "2026-10-01T09:00:00.000Z",
  gameCount = 6,
  teamCount = 12,
  usersPerGame = 200,
  jobCount = 240
} = {}) {
  if (gameCount !== 6) throw new Error("the load scenario must model six simultaneous games");
  if (teamCount !== TEAM_CODES.length) throw new Error("the load scenario must model twelve teams");
  if (usersPerGame < 1 || jobCount < 200) throw new Error("load scenario is below the required minimum");

  const teams = TEAM_CODES.map((code, index) => ({ teamCode: code, name: `Test ${code}`, index }));
  const players = teams.flatMap((team) => createPlayers(team.teamCode, team.index));
  const games = Array.from({ length: gameCount }, (_, index) => {
    const home = teams[index * 2];
    const away = teams[index * 2 + 1];
    const startsAt = isoAt(baseAt, index * 15);
    return {
      internalGameId: `offseason-game-${index + 1}`,
      gameDate: startsAt.slice(0, 10),
      homeTeam: home.teamCode,
      awayTeam: away.teamCode,
      predictionDeadlineAt: isoAt(startsAt, -30),
      startsAt,
      status: "scheduled"
    };
  });

  const predictions = games.flatMap((game, gameIndex) => {
    const lineup = createActualLineup(players.filter((player) => player.teamCode === game.homeTeam));
    return Array.from({ length: usersPerGame }, (_, userIndex) => ({
      predictionId: `offseason-prediction-${gameIndex + 1}-${userIndex + 1}`,
      userId: `offseason-user-${userIndex + 1}`,
      internalGameId: game.internalGameId,
      submittedAt: isoAt(game.predictionDeadlineAt, -5),
      status: "scored",
      lineup: createPrediction(lineup, userIndex, gameIndex),
      score: scorePredictionLineup(createPrediction(lineup, userIndex, gameIndex), lineup).total,
      maxScore: 99
    }));
  });

  const jobs = Array.from({ length: jobCount }, (_, index) => ({
    jobId: `offseason-job-${index + 1}`,
    internalGameId: games[index % games.length].internalGameId,
    jobType: index % 3 === 0 ? "score" : index % 3 === 1 ? "rank" : "publish",
    status: index % 5 === 0 ? "claimed" : "pending",
    runAfter: isoAt(baseAt, index)
  }));

  return { teams, players, games, predictions, jobs };
}
