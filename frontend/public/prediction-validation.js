(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicPredictionValidation({ normalizeLineup }) {
    function getDuplicateValues(values) {
      const counts = new Map();
      values.filter(Boolean).forEach((value) => {
        counts.set(value, (counts.get(value) || 0) + 1);
      });
      return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([value]) => value));
    }

    function getDuplicatedPlayers(lineup) {
      return getDuplicateValues(lineup.map((item) => item.player));
    }

    function getDuplicatedPositions(lineup) {
      // Preserve the existing repeated-DH exception; this check must not infer rules from registered roster positions.
      return getDuplicateValues(lineup.map((item) => item.position).filter((position) => position && position !== "指"));
    }

    function validateLineup(lineup, label) {
      if (lineup.some((item) => !item.player)) {
        return `${label}は1番から9番まで全て選択してください。`;
      }

      if (lineup.some((item) => !item.position)) {
        return `${label}は1番から9番まで守備位置を全て選択してください。`;
      }

      if (getDuplicatedPlayers(lineup).size > 0) {
        return `${label}に同じ選手が複数回選ばれています。別の選手を選んでください。`;
      }

      if (getDuplicatedPositions(lineup).size > 0) {
        return `${label}に同じ守備位置が複数回選ばれています。別の守備位置を選んでください。`;
      }

      return "";
    }

    function hasCompletePositions(lineup) {
      // Use the app's existing normalizer so saved and current lineups share the same slot interpretation.
      return normalizeLineup(lineup).every((item) => item.position);
    }

    return { getDuplicatedPlayers, getDuplicatedPositions, validateLineup, hasCompletePositions };
  }

  publicFrontend.createPublicPredictionValidation = createPublicPredictionValidation;
})();
