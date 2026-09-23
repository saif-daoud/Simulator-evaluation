const config = window.SIMULATOR_EVAL_CONFIG || {};

const ratingMetrics = [
  {
    key: "coherence",
    label: "Coherence",
    description: "The patient's responses remain internally consistent and aligned with the supplied case profile."
  },
  {
    key: "disclosure",
    label: "Disclosure",
    description: "Personal information is revealed at a clinically plausible pace rather than dumped, withheld, or introduced without context."
  },
  {
    key: "resistance",
    label: "Resistance",
    description: "Hesitation, avoidance, disagreement, or engagement changes feel plausible for this patient and the therapist's approach."
  },
  {
    key: "emotional",
    label: "Emotional expression",
    description: "Affect is credible, appropriately varied, and continuous with the patient's situation and the unfolding exchange."
  },
  {
    key: "realism",
    label: "Realism",
    description: "Overall, the interaction resembles a believable human patient rather than an assistant, script, or language model."
  }
];

const scoreLabels = ["Poor", "Weak", "Acceptable", "Strong", "Excellent"];
const totalSimulatorSessions = 3;
const storage = { token: "sim-eval-token", participant: "sim-eval-participant" };

const state = {
  token: sessionStorage.getItem(storage.token) || "",
  participant: sessionStorage.getItem(storage.participant) || "",
  profiles: [],
  studies: {},
  study: null,
  view: "login",
  pending: false,
  toastTimer: null
};

const $ = id => document.getElementById(id);
const el = {
  views: [...document.querySelectorAll(".view")],
  home: $("home-link"), signOut: $("sign-out-button"),
  loginForm: $("login-form"), participant: $("participant-code"), access: $("access-code"), loginButton: $("login-button"), loginError: $("login-error"),
  profileGrid: $("profile-grid"), caseBack: $("case-back-button"), caseTitle: $("case-title"), caseCondition: $("case-condition"), caseCode: $("case-code"), caseSummary: $("case-summary"), caseContext: $("case-context"), caseHistory: $("case-history"), caseCoping: $("case-coping"), caseProgressCopy: $("case-progress-copy"), caseProgressBar: $("case-progress-bar"), sessionList: $("session-list"),
  sessionBack: $("session-back-button"), sessionPosition: $("session-position"), sessionTitle: $("session-title"), viewProfile: $("view-profile-button"), endSession: $("end-session-button"), turnCounter: $("turn-counter"), chatPatientLabel: $("chat-patient-label"), chatState: $("chat-state"), messages: $("messages"), typing: $("typing-row"), messageForm: $("message-form"), messageInput: $("message-input"), send: $("send-button"),
  ratingPosition: $("rating-position"), ratingProfile: $("rating-profile-button"), transcriptCount: $("transcript-count"), ratingTranscript: $("rating-transcript"), ratingForm: $("rating-form"), ratingItems: $("rating-items"), ratingComments: $("rating-comments"), ratingError: $("rating-error"), submitRating: $("submit-rating-button"),
  completeButton: $("complete-button"), dialog: $("profile-dialog"), dialogTitle: $("dialog-title"), dialogCondition: $("dialog-condition"), dialogSummary: $("dialog-summary"), dialogContext: $("dialog-context"), dialogHistory: $("dialog-history"), dialogCoping: $("dialog-coping"), closeDialog: $("close-dialog-button"), toast: $("toast")
};

function showView(name) {
  state.view = name;
  for (const view of el.views) view.classList.toggle("hidden", view.id !== `${name}-view`);
  const authenticated = Boolean(state.token);
  el.signOut.classList.toggle("hidden", !authenticated);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showToast(message, isError = false) {
  window.clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.className = `toast${isError ? " error" : ""}`;
  state.toastTimer = window.setTimeout(() => el.toast.classList.add("hidden"), 4200);
}

function apiUrl(path) {
  return `${String(config.apiBase || "").replace(/\/$/, "")}${path}`;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token && !options.public) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(apiUrl(path), { method: options.method || "POST", ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function checkHealth() {
  try {
    const response = await fetch(apiUrl("/api/health"));
    if (!response.ok) throw new Error();
    return true;
  } catch {
    return false;
  }
}

function handleError(error) {
  if (error.status === 401) {
    signOut();
    showToast("Your study session expired. Please sign in again.", true);
    return;
  }
  showToast(error.message || "Something went wrong.", true);
}

function automaticTerminationNotice(session) {
  if (session?.termination_reason === "max_turns") return "The session reached 50 turns and ended automatically.";
  if (session?.termination_reason === "therapist_farewell") return "The session ended after your farewell.";
  if (session?.termination_reason === "patient_farewell") return "The session ended after the patient's farewell.";
  return "";
}

function signOut() {
  state.token = "";
  state.participant = "";
  state.profiles = [];
  state.studies = {};
  state.study = null;
  sessionStorage.removeItem(storage.token);
  sessionStorage.removeItem(storage.participant);
  el.access.value = "";
  showView("login");
}

function fillList(node, values) {
  node.replaceChildren();
  for (const value of values || []) {
    const item = document.createElement("li");
    item.textContent = value;
    node.appendChild(item);
  }
}

function profileStudy(profileId) {
  return state.studies[profileId] || null;
}

function renderProfileCards() {
  el.profileGrid.replaceChildren();
  for (const profile of state.profiles) {
    const summary = profileStudy(profile.id);
    const complete = summary?.status === "completed";
    const completed = summary?.completed_sessions || 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-card";
    button.innerHTML = `
      <div class="card-meta"><span class="case-number">${String(profile.display_number).padStart(2, "0")}</span><span class="case-status ${complete ? "complete" : completed ? "in-progress" : ""}">${complete ? "Complete" : completed ? "In progress" : "Not started"}</span></div>
      <h2></h2><span class="condition"></span><p></p>
      <div class="card-footer"><span>${complete ? "Review case" : completed ? "Continue evaluation" : "Open case"} →</span><span class="mini-progress" aria-label="${completed} of ${totalSimulatorSessions} complete">${Array.from({ length: totalSimulatorSessions }, (_, index) => `<i class="${index < completed ? "done" : ""}"></i>`).join("")}</span></div>`;
    button.querySelector("h2").textContent = profile.display_name;
    button.querySelector(".condition").textContent = profile.condition;
    button.querySelector(":scope > p").textContent = profile.short_description;
    button.addEventListener("click", () => openCase(profile.id));
    el.profileGrid.appendChild(button);
  }
}

async function loadDashboard() {
  try {
    const payload = await api("/api/bootstrap", { body: "{}" });
    state.profiles = payload.profiles;
    state.studies = Object.fromEntries((payload.studies || []).map(study => [study.profile_id, study]));
    renderProfileCards();
    showView("dashboard");
  } catch (error) {
    handleError(error);
  }
}

function setCaseContent(profile) {
  el.caseTitle.textContent = profile.display_name;
  el.caseCondition.textContent = profile.condition;
  el.caseCode.textContent = `CASE ${String(profile.display_number).padStart(2, "0")}`;
  el.caseSummary.textContent = profile.summary;
  el.caseContext.textContent = profile.current_context;
  el.caseHistory.textContent = profile.relevant_history;
  fillList(el.caseCoping, profile.coping_strategies);
}

function currentSession() {
  if (!state.study) return null;
  return state.study.sessions.find(session => ["ready", "active", "rating"].includes(session.status))
    || state.study.sessions.find(session => session.status !== "completed")
    || state.study.sessions.at(-1);
}

function updateCaseProgress() {
  const completed = state.study?.completed_sessions || 0;
  const total = state.study?.total_sessions || totalSimulatorSessions;
  el.caseProgressCopy.textContent = `${completed} of ${total} completed`;
  el.caseProgressBar.style.width = `${(completed / total) * 100}%`;
}

function sessionStatusText(session) {
  if (session.status === "completed") return "Evaluation saved";
  if (session.status === "rating") return "Awaiting evaluation";
  if (session.status === "active") return "Conversation active";
  if (session.status === "ready") return "Ready to begin";
  return "Complete the previous session";
}

function renderSessionList() {
  el.sessionList.replaceChildren();
  for (const session of state.study.sessions) {
    const item = document.createElement("article");
    item.className = `session-item ${session.status === "locked" ? "locked" : ""} ${["ready", "active", "rating"].includes(session.status) ? "current" : ""}`;
    const action = document.createElement("span");
    if (["ready", "active", "rating"].includes(session.status)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = session.status === "rating" ? "Rate" : session.status === "active" ? "Continue" : "Begin";
      button.addEventListener("click", () => session.status === "rating" ? showRating() : showSession());
      action.appendChild(button);
    } else {
      action.className = `status-icon ${session.status === "completed" ? "done" : ""}`;
      action.textContent = session.status === "completed" ? "✓" : "⌁";
    }
    const index = document.createElement("span");
    index.className = "session-index";
    index.textContent = session.anonymous_label.slice(-1);
    const copy = document.createElement("div");
    copy.className = "session-copy";
    const title = document.createElement("strong");
    title.textContent = session.anonymous_label;
    const status = document.createElement("small");
    status.textContent = sessionStatusText(session);
    copy.append(title, status);
    item.append(index, copy, action);
    el.sessionList.appendChild(item);
  }
}

function showCase() {
  if (!state.study) return loadDashboard();
  setCaseContent(state.study.profile);
  updateCaseProgress();
  renderSessionList();
  showView("case");
}

async function openCase(profileId) {
  if (state.pending) return;
  state.pending = true;
  try {
    const summary = profileStudy(profileId);
    const payload = summary
      ? await api("/api/study", { body: JSON.stringify({ study_id: summary.id }) })
      : await api("/api/studies/start", { body: JSON.stringify({ profile_id: profileId, client_request_id: crypto.randomUUID() }) });
    state.study = payload.study;
    state.studies[profileId] = {
      id: state.study.id,
      profile_id: state.study.profile.id,
      status: state.study.status,
      completed_sessions: state.study.completed_sessions
    };
    showCase();
  } catch (error) {
    handleError(error);
  } finally {
    state.pending = false;
  }
}

function appendMessage(container, message) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${message.role}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = message.role === "therapist" ? "You · Therapist" : "Simulated patient";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.content;
  wrapper.append(label, bubble);
  if (message.created_at) {
    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    wrapper.appendChild(time);
  }
  container.appendChild(wrapper);
}

function renderChat(session) {
  el.messages.replaceChildren();
  if (!session.messages.length && session.status === "ready") {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.innerHTML = `<div><div class="patient-avatar" aria-hidden="true"><span></span></div><h2>Begin the conversation</h2><p>Start when you are ready.</p><button class="primary-button" type="button">Start conversation</button></div>`;
    empty.querySelector("button").addEventListener("click", startSession);
    el.messages.appendChild(empty);
  } else if (!session.messages.length && session.status === "active") {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.innerHTML = `<div><div class="patient-avatar" aria-hidden="true"><span></span></div><h2>You begin this session</h2><p>Send the first message as the therapist.</p></div>`;
    el.messages.appendChild(empty);
  } else {
    for (const message of session.messages) appendMessage(el.messages, message);
    requestAnimationFrame(() => { el.messages.scrollTop = el.messages.scrollHeight; });
  }
  const therapistTurns = session.messages.filter(message => message.role === "therapist").length;
  el.turnCounter.textContent = `${therapistTurns} therapist turn${therapistTurns === 1 ? "" : "s"}`;
  el.endSession.disabled = state.pending || !session.can_end;
  el.messageInput.disabled = state.pending || !session.can_send;
  el.messageInput.placeholder = !session.messages.length && session.status === "active"
    ? "Begin as the therapist…"
    : "Respond as the therapist…";
  el.send.disabled = el.messageInput.disabled || !el.messageInput.value.trim();
  el.typing.classList.toggle("hidden", !state.pending);
  el.chatState.className = `chat-state${state.pending ? " busy" : ""}`;
  el.chatState.innerHTML = `<i></i> ${state.pending ? "Generating" : session.status === "ready" ? "Not started" : "Ready"}`;
}

function showSession() {
  const session = currentSession();
  if (!session) return showCase();
  if (session.status === "rating") return showRating();
  if (session.status === "locked" || session.status === "completed") return showCase();
  el.sessionPosition.textContent = `Session ${session.display_order} of ${state.study.total_sessions || totalSimulatorSessions}`;
  el.sessionTitle.textContent = session.anonymous_label;
  el.chatPatientLabel.textContent = session.anonymous_label;
  renderChat(session);
  showView("session");
}

async function refreshStudy() {
  const payload = await api("/api/study", { body: JSON.stringify({ study_id: state.study.id }) });
  state.study = payload.study;
  state.studies[state.study.profile.id] = {
    id: state.study.id,
    profile_id: state.study.profile.id,
    status: state.study.status,
    completed_sessions: state.study.completed_sessions
  };
}

async function startSession() {
  const session = currentSession();
  if (!session || session.status !== "ready" || state.pending) return;
  state.pending = true;
  renderChat(session);
  try {
    const payload = await api("/api/sessions/start", { body: JSON.stringify({ session_id: session.id, client_request_id: crypto.randomUUID() }) });
    state.study = payload.study;
    const updated = currentSession();
    const notice = automaticTerminationNotice(updated);
    if (notice) showToast(notice);
    updated?.status === "rating" ? showRating() : showSession();
  } catch (error) {
    handleError(error);
    await refreshStudy().catch(() => {});
    showSession();
  } finally {
    state.pending = false;
    if (state.view === "session") renderChat(currentSession());
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const session = currentSession();
  const content = el.messageInput.value.trim();
  if (!session?.can_send || !content || state.pending) return;
  const clientMessageId = crypto.randomUUID();
  session.messages.push({ id: `local-${clientMessageId}`, role: "therapist", content, created_at: new Date().toISOString() });
  el.messageInput.value = "";
  state.pending = true;
  renderChat(session);
  try {
    const payload = await api("/api/sessions/message", { body: JSON.stringify({ session_id: session.id, content, client_message_id: clientMessageId }) });
    state.study = payload.study;
    const updated = currentSession();
    const notice = automaticTerminationNotice(updated);
    if (notice) showToast(notice);
    if (updated?.status === "rating") showRating();
  } catch (error) {
    handleError(error);
    await refreshStudy().catch(() => {});
  } finally {
    state.pending = false;
    if (state.view === "session") renderChat(currentSession());
  }
}

async function endSession() {
  const session = currentSession();
  if (!session?.can_end || state.pending) return;
  if (!window.confirm("End this conversation and evaluate the simulated patient? You will not be able to send more messages.")) return;
  state.pending = true;
  el.endSession.disabled = true;
  try {
    const payload = await api("/api/sessions/end", { body: JSON.stringify({ session_id: session.id, client_request_id: crypto.randomUUID() }) });
    state.study = payload.study;
    showRating();
  } catch (error) {
    handleError(error);
  } finally {
    state.pending = false;
  }
}

function buildRatingForm() {
  el.ratingItems.replaceChildren();
  ratingMetrics.forEach((metric, index) => {
    const card = document.createElement("section");
    card.className = "metric-card";
    card.dataset.metric = metric.key;
    const heading = document.createElement("div");
    heading.className = "metric-heading";
    const number = document.createElement("span");
    number.className = "metric-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = metric.label;
    const description = document.createElement("p");
    description.textContent = metric.description;
    copy.append(title, description);
    heading.append(number, copy);
    const scores = document.createElement("div");
    scores.className = "score-scale";
    scoreLabels.forEach((labelText, scoreIndex) => {
      const label = document.createElement("label");
      label.className = "score-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = metric.key;
      input.value = String(scoreIndex + 1);
      input.required = true;
      input.addEventListener("change", () => {
        scores.querySelectorAll(".score-option").forEach(node => node.classList.toggle("selected", node === label));
        el.ratingError.classList.add("hidden");
      });
      const value = document.createElement("strong");
      value.textContent = String(scoreIndex + 1);
      const caption = document.createElement("small");
      caption.textContent = labelText;
      label.append(input, value, caption);
      scores.appendChild(label);
    });
    card.append(heading, scores);
    el.ratingItems.appendChild(card);
  });
}

function showRating() {
  const session = currentSession();
  if (!session || session.status !== "rating") return showCase();
  el.ratingPosition.textContent = `Session ${session.display_order} of ${state.study.total_sessions || totalSimulatorSessions} · evaluation`;
  el.ratingTranscript.replaceChildren();
  for (const message of session.messages) appendMessage(el.ratingTranscript, message);
  el.transcriptCount.textContent = `${session.messages.length} messages`;
  el.ratingForm.reset();
  el.ratingForm.querySelectorAll(".score-option").forEach(node => node.classList.remove("selected"));
  el.ratingError.classList.add("hidden");
  showView("rating");
}

async function submitRating(event) {
  event.preventDefault();
  const session = currentSession();
  if (!session || session.status !== "rating" || state.pending) return;
  const scores = {};
  for (const metric of ratingMetrics) {
    const checked = el.ratingForm.querySelector(`input[name="${metric.key}"]:checked`);
    if (!checked) {
      el.ratingError.textContent = `Please score ${metric.label.toLowerCase()} before submitting.`;
      el.ratingError.classList.remove("hidden");
      el.ratingForm.querySelector(`[data-metric="${metric.key}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    scores[metric.key] = Number(checked.value);
  }
  state.pending = true;
  el.submitRating.disabled = true;
  try {
    const payload = await api("/api/sessions/rate", { body: JSON.stringify({ session_id: session.id, scores, comments: el.ratingComments.value.trim(), client_request_id: crypto.randomUUID() }) });
    state.study = payload.study;
    state.studies[state.study.profile.id] = { id: state.study.id, profile_id: state.study.profile.id, status: state.study.status, completed_sessions: state.study.completed_sessions };
    showToast("Evaluation saved.");
    if (state.study.status === "completed") showView("complete");
    else showCase();
  } catch (error) {
    handleError(error);
  } finally {
    state.pending = false;
    el.submitRating.disabled = false;
  }
}

function openProfileDialog() {
  const profile = state.study?.profile;
  if (!profile) return;
  el.dialogTitle.textContent = profile.display_name;
  el.dialogCondition.textContent = profile.condition;
  el.dialogSummary.textContent = profile.summary;
  el.dialogContext.textContent = profile.current_context;
  el.dialogHistory.textContent = profile.relevant_history;
  fillList(el.dialogCoping, profile.coping_strategies);
  el.dialog.showModal();
}

el.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (state.pending) return;
  state.pending = true;
  el.loginError.classList.add("hidden");
  el.loginButton.disabled = true;
  try {
    const payload = await api("/api/auth/login", {
      public: true,
      body: JSON.stringify({ participant_code: el.participant.value.trim(), access_code: el.access.value })
    });
    state.token = payload.token;
    state.participant = payload.participant_code;
    sessionStorage.setItem(storage.token, state.token);
    sessionStorage.setItem(storage.participant, state.participant);
    await loadDashboard();
  } catch (error) {
    el.loginError.textContent = error.message;
    el.loginError.classList.remove("hidden");
  } finally {
    state.pending = false;
    el.loginButton.disabled = false;
  }
});

el.home.addEventListener("click", event => { event.preventDefault(); if (state.token) loadDashboard(); });
el.signOut.addEventListener("click", signOut);
el.caseBack.addEventListener("click", loadDashboard);
el.sessionBack.addEventListener("click", showCase);
el.viewProfile.addEventListener("click", openProfileDialog);
el.ratingProfile.addEventListener("click", openProfileDialog);
el.closeDialog.addEventListener("click", () => el.dialog.close());
el.dialog.addEventListener("click", event => { if (event.target === el.dialog) el.dialog.close(); });
el.endSession.addEventListener("click", endSession);
el.messageForm.addEventListener("submit", sendMessage);
el.messageInput.addEventListener("input", () => {
  el.messageInput.style.height = "auto";
  el.messageInput.style.height = `${Math.min(el.messageInput.scrollHeight, 110)}px`;
  el.send.disabled = state.pending || !el.messageInput.value.trim() || el.messageInput.disabled;
});
el.messageInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); el.messageForm.requestSubmit(); }
});
el.ratingForm.addEventListener("submit", submitRating);
el.completeButton.addEventListener("click", loadDashboard);

async function boot() {
  buildRatingForm();
  checkHealth();
  if (state.token) {
    el.participant.value = state.participant;
    await loadDashboard();
  } else {
    showView("login");
  }
}

boot();
