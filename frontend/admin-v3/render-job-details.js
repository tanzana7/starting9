(function registerAdminV3JobDetails(global) {
  "use strict";

  function createAdminV3JobDetailsRenderer({ state, document, navigator, escapeHtml, formatJst, statusLabel, jobLabels, latestJobs }) {
    const fields = Object.freeze([
      ["job_type", "jobType"],
      ["status", "status"],
      ["scheduled_at", "scheduledAt"],
      ["scheduled_slot_at", "scheduledSlotAt"],
      ["attempt_count", "attemptCount"],
      ["max_attempts", "maxAttempts"],
      ["next_retry_at", "nextRetryAt"],
      ["claimed_at", "claimedAt"],
      ["lease_expires_at", "leaseExpiresAt"],
      ["completed_at", "completedAt"],
      ["failure_code", "failureCode"],
      ["job_id", "jobId"],
      ["internal_game_id", "internalGameId"],
      ["lineup_revision_id", "lineupRevisionId"],
      ["scoring_revision_id", "scoringRevisionId"],
      ["ranking_revision_id", "rankingRevisionId"],
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"]
    ]);

    function key(internalGameId, jobId) {
      return `${String(internalGameId || "").trim()}:${String(jobId || "").trim()}`;
    }

    function domId(value) {
      return `v3-job-detail-${String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    }

    function field(job, snakeName, camelName, fallback = "") {
      const value = job?.[snakeName] ?? job?.[camelName];
      return value === null || value === undefined ? fallback : value;
    }

    function rawFields(internalGameId, detail) {
      const job = detail?.job || detail || {};
      return fields.map(([snakeName, camelName]) => {
        const raw = snakeName === "job_id"
          ? field(job, snakeName, camelName, job.id)
          : snakeName === "internal_game_id"
            ? field(job, snakeName, camelName, internalGameId)
            : field(job, snakeName, camelName, "");
        return { snakeName, camelName, raw: raw === null || raw === undefined ? "" : String(raw) };
      }).filter((item) => item.raw !== "");
    }

    function displayValue(item) {
      if (item.snakeName.endsWith("_at") || item.snakeName === "claimed_at" || item.snakeName === "completed_at") {
        const formatted = formatJst(item.raw);
        return formatted === "-" ? item.raw : `${formatted} JST (${item.raw})`;
      }
      return item.raw;
    }

    function copyText(internalGameId, detail) {
      const job = detail?.job || detail || {};
      const lines = rawFields(internalGameId, detail).map((item) => `${item.camelName}: ${item.raw}`);
      if (job.failure_message || job.failureMessage) lines.push(`failureMessage:\n${job.failure_message || job.failureMessage}`);
      if (detail?.plannerDecision) lines.push(`plannerDecision:\n${JSON.stringify(detail.plannerDecision, null, 2)}`);
      if (detail?.pipelineDiagnostics) lines.push(`pipelineDiagnostics:\n${JSON.stringify(detail.pipelineDiagnostics, null, 2)}`);
      if (Array.isArray(detail?.pipelineEvents) && detail.pipelineEvents.length) lines.push(`pipelineEvents:\n${JSON.stringify(detail.pipelineEvents, null, 2)}`);
      if (Array.isArray(detail?.audits) && detail.audits.length) lines.push(`audits:\n${JSON.stringify(detail.audits, null, 2)}`);
      return lines.join("\n");
    }

    function copyButton(copyType, label, value, internalGameId, jobId) {
      if (!value) return "";
      return `<button type="button" class="job-detail-copy" data-v3-job-copy="${escapeHtml(copyType)}" data-v3-job-copy-game="${escapeHtml(internalGameId)}" data-v3-job-copy-id="${escapeHtml(jobId)}">${escapeHtml(label)}</button>`;
    }

    function renderInline(game, job) {
      const detailKey = key(game.internalGameId, job.id);
      if (!state.jobDetailsOpen.has(detailKey)) return "";
      const detailDomId = domId(detailKey);
      const detail = state.jobDetails.get(detailKey);
      if (state.jobDetailsLoading.has(detailKey)) return `<div id="${escapeHtml(detailDomId)}" class="job-detail-inline" aria-busy="true"><p>job詳細を読み込んでいます。</p></div>`;
      if (detail?.error) return `<div id="${escapeHtml(detailDomId)}" class="job-detail-inline job-detail-error"><p>${escapeHtml(detail.error)}</p><button type="button" data-v3-job-detail-refresh="${escapeHtml(game.internalGameId)}" data-v3-job-detail-refresh-id="${escapeHtml(job.id)}">再取得</button></div>`;
      if (!detail) return `<div id="${escapeHtml(detailDomId)}" class="job-detail-inline"><p>job詳細を取得できませんでした。</p></div>`;
      const detailedJob = detail.job || detail;
      const detailFields = rawFields(game.internalGameId, detail);
      const failureMessage = field(detailedJob, "failure_message", "failureMessage", "");
      const plannerDecision = detail.plannerDecision || detail.pipelineDiagnostics?.plannerDecision || null;
      const fullText = copyText(game.internalGameId, detail);
      const copyStatus = state.jobDetailsCopyStatus?.get(detailKey) || "";
      const fieldMarkup = detailFields.map((item) => `<div class="job-detail-field"><dt>${escapeHtml(item.camelName)}</dt><dd class="job-detail-value">${escapeHtml(displayValue(item))}${copyButton(item.camelName, "コピー", item.raw, game.internalGameId, job.id)}</dd></div>`).join("");
      const failureMarkup = failureMessage ? `<div class="job-detail-field job-detail-field-full"><dt>failureMessage ${copyButton("failureMessage", "エラーをコピー", String(failureMessage), game.internalGameId, job.id)}</dt><dd><pre class="job-detail-pre">${escapeHtml(String(failureMessage))}</pre></dd></div>` : "";
      const plannerMarkup = plannerDecision ? `<div class="job-detail-field job-detail-field-full"><dt>planner decision</dt><dd><pre class="job-detail-pre">${escapeHtml(JSON.stringify(plannerDecision, null, 2))}</pre></dd></div>` : "";
      const pipelineMarkup = detail.pipelineDiagnostics ? `<div class="job-detail-field job-detail-field-full"><dt>pipeline diagnostics</dt><dd><pre class="job-detail-pre">${escapeHtml(JSON.stringify(detail.pipelineDiagnostics, null, 2))}</pre></dd></div>` : "";
      const eventMarkup = Array.isArray(detail.pipelineEvents) && detail.pipelineEvents.length ? `<div class="job-detail-field job-detail-field-full"><dt>pipeline events</dt><dd><pre class="job-detail-pre">${escapeHtml(JSON.stringify(detail.pipelineEvents, null, 2))}</pre></dd></div>` : "";
      const auditMarkup = Array.isArray(detail.audits) && detail.audits.length ? `<div class="job-detail-field job-detail-field-full"><dt>audits</dt><dd><pre class="job-detail-pre">${escapeHtml(JSON.stringify(detail.audits, null, 2))}</pre></dd></div>` : "";
      return `<section id="${escapeHtml(detailDomId)}" class="job-detail-inline" aria-label="job詳細"><div class="job-detail-toolbar"><strong>job詳細</strong>${copyButton("all", "詳細をすべてコピー", fullText, game.internalGameId, job.id)}<span class="job-copy-status" aria-live="polite">${escapeHtml(copyStatus)}</span></div><dl class="job-detail-grid">${fieldMarkup}${failureMarkup}${plannerMarkup}${pipelineMarkup}${eventMarkup}${auditMarkup}</dl><button type="button" class="job-detail-refresh" data-v3-job-detail-refresh="${escapeHtml(game.internalGameId)}" data-v3-job-detail-refresh-id="${escapeHtml(job.id)}">再取得</button></section>`;
    }

    function renderRows(game, types) {
      const jobs = latestJobs(game, types);
      return jobs.length ? `<div class="job-list">${jobs.map((job) => {
        const detailKey = key(game.internalGameId, job.id);
        const open = state.jobDetailsOpen.has(detailKey);
        return `<div class="job-entry"><div class="job"><code>${escapeHtml(jobLabels[job.job_type] || job.job_type)}</code><span class="job-status">${escapeHtml(statusLabel(job.status))}</span><span>${escapeHtml(job.failure_code || `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}`)}<br><small>予定 ${escapeHtml(formatJst(job.scheduled_at))}</small></span><button type="button" aria-expanded="${open ? "true" : "false"}" aria-controls="${escapeHtml(domId(detailKey))}" data-v3-job-detail="${escapeHtml(game.internalGameId)}" data-v3-job-id="${escapeHtml(job.id)}">詳細</button></div>${renderInline(game, job)}</div>`;
      }).join("")}</div>` : "<span class=muted>該当jobの履歴はありません。</span>";
    }

    async function copyTextSafely(value) {
      const text = String(value ?? "");
      if (navigator?.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {
          // Embedded admin pages may not have clipboard permission.
        }
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = typeof document.execCommand === "function" && document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("CLIPBOARD_UNAVAILABLE");
    }

    function copyValue(copyType, internalGameId, detail) {
      const job = detail?.job || detail || {};
      if (copyType === "all") return copyText(internalGameId, detail);
      if (copyType === "failureMessage") return String(field(job, "failure_message", "failureMessage", ""));
      const item = fields.find((candidate) => candidate[1] === copyType);
      return item ? field(job, item[0], item[1], item[0] === "job_id" ? job?.id : item[0] === "internal_game_id" ? internalGameId : "") : "";
    }

    return Object.freeze({
      fields,
      key,
      domId,
      field,
      copyText,
      copyValue,
      copyTextSafely,
      renderInline,
      renderRows
    });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3JobDetailsRenderer = createAdminV3JobDetailsRenderer;
})(window);
