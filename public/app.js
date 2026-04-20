const state = {
  user: null,
  report: null,
  submissions: [],
  token: null,
  authMode: "login"
};

const sampleText = `Artificial intelligence systems influence education by automating feedback, identifying patterns in student work, and raising questions about authorship, transparency, and accountability. Strong research writing introduces a claim, integrates evidence, explains the reasoning, and uses a consistent citation style. Academic integrity requires that students cite sources accurately and avoid copying language without quotation marks. However, AI tools can also support learning when students disclose assistance and teachers set clear boundaries. "Feedback should help writers revise ideas, evidence, and structure" (Miller, 2022). References
Miller, A. (2022). Responsible academic writing. Example Press.`;

const $ = selector => document.querySelector(selector);

function setProgress(label, value) {
  $("#progressLabel").textContent = label;
  $("#progressBar").style.width = `${value}%`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}

async function ensureUser() {
  if (state.user) return state.user;
  showLoginPanel("Please login first to upload documents.");
  throw new Error("Login required before upload.");
}

function saveSession(user, token) {
  state.user = user;
  state.token = token;
  localStorage.setItem("integrityAiSession", JSON.stringify({ user, token }));
  updateAuthUi();
  loadSubmissions().catch(() => {});
}

function loadSession() {
  try {
    const session = JSON.parse(localStorage.getItem("integrityAiSession") || "null");
    if (session?.user?.id) {
      state.user = session.user;
      state.token = session.token || null;
    }
  } catch {
    localStorage.removeItem("integrityAiSession");
  }
  updateAuthUi();
}

function clearSession() {
  state.user = null;
  state.token = null;
  state.submissions = [];
  localStorage.removeItem("integrityAiSession");
  updateAuthUi();
  renderSubmissions();
  setProgress("Login required before upload", 0);
}

function showLoginPanel(message = "Use your email to continue.") {
  $("#authPanel").classList.remove("hidden");
  $("#authMessage").textContent = message;
  $("#authEmail").focus();
}

function hideLoginPanel() {
  $("#authPanel").classList.add("hidden");
}

function updateAuthUi() {
  const loggedIn = Boolean(state.user);
  $("#authStatus").textContent = loggedIn ? `${state.user.name} (${state.user.role})` : "Not logged in";
  $("#loginToggle").classList.toggle("hidden", loggedIn);
  $("#logoutButton").classList.toggle("hidden", !loggedIn);
  $("#loginRequired").classList.toggle("hidden", loggedIn);
  $("#documentInput").disabled = !loggedIn;
  $("#chooseDocumentButton").classList.toggle("disabled", !loggedIn);
  $("#sampleButton").classList.toggle("disabled", !loggedIn);
  $("#uploadForm").querySelector("button[type='submit']").disabled = !loggedIn;
  $("#uploadForm").querySelector("button[type='submit']").classList.toggle("disabled", !loggedIn);

  if (loggedIn) {
    $("#emailInput").value = state.user.email;
    $("#nameInput").value = state.user.name;
    setProgress("Ready for document upload", 0);
  } else {
    $("#emailInput").value = "";
    $("#nameInput").value = "";
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === "register";
  $("#loginTab").classList.toggle("active", !isRegister);
  $("#registerTab").classList.toggle("active", isRegister);
  $("#authTitle").textContent = isRegister ? "Register your account" : "Login to upload documents";
  $("#authSubmit").textContent = isRegister ? "Register" : "Login";
  $("#authNameLabel").classList.toggle("hidden", !isRegister);
  $("#authRole").closest("label").classList.toggle("hidden", !isRegister);
  $("#authName").required = isRegister;
  $("#authMessage").textContent = isRegister
    ? "Create an account first. After registration you will be logged in."
    : "Login with your registered email and password.";
}

async function submitAuth(event) {
  event.preventDefault();
  const isRegister = state.authMode === "register";
  const payload = {
    name: $("#authName").value.trim() || "Demo Student",
    email: $("#authEmail").value.trim(),
    password: $("#authPassword").value,
    role: $("#authRole").value || "student"
  };
  if (!payload.email) {
    $("#authMessage").textContent = "Email is required.";
    return;
  }
  if (!payload.password || payload.password.length < 6) {
    $("#authMessage").textContent = "Password must be at least 6 characters.";
    return;
  }

  $("#authMessage").textContent = isRegister ? "Registering..." : "Logging in...";
  try {
    const result = await api(isRegister ? "/auth/register" : "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (isRegister) {
      setAuthMode("login");
      $("#authPassword").value = "";
      $("#authMessage").textContent = "Registration successful. Now login with your email and password.";
      return;
    }
    saveSession(result.user, result.token);
    hideLoginPanel();
    $("#authMessage").textContent = "Login successful.";
  } catch (error) {
    $("#authMessage").textContent = error.message;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function riskClass(value) {
  if (value >= 65) return "high-risk";
  if (value >= 35) return "medium-risk";
  return "low-risk";
}

function markText(text, segments) {
  if (!segments.length) return escapeHtml(text);
  let html = escapeHtml(text);
  const sorted = [...segments].sort((a, b) => b.matchedText.length - a.matchedText.length).slice(0, 12);
  for (const segment of sorted) {
    const safe = escapeHtml(segment.matchedText);
    if (!safe || !html.includes(safe)) continue;
    html = html.replace(safe, `<mark class="match-${segment.type}" title="${escapeHtml(segment.sourceTitle)}: ${segment.score}%">${safe}</mark>`);
  }
  return html;
}

function renderReport(report) {
  state.report = report;
  $("#similarityScore").textContent = `${report.similarity.overall}%`;
  $("#writingScore").textContent = `${report.writing.readability}%`;
  $("#aiScore").textContent = `${report.aiContent.probability}%`;
  $("#aiLabel").textContent = report.aiContent.label;
  $("#integrityScore").textContent = `${report.integrityScore}%`;
  $("#wordCount").textContent = `${report.wordCount} words`;
  $("#documentText").innerHTML = markText(report.extractedText, report.similarity.segments);

  $("#feedbackList").innerHTML = report.writing.suggestions
    .map(item => `<li><strong>${escapeHtml(item.category)}</strong><br>${escapeHtml(item.message)}</li>`)
    .join("");

  $("#citationSummary").textContent = `${report.citations.styleGuess}, ${report.citations.inTextCitationCount} citation signal(s), bibliography ${report.citations.bibliographyFound ? "found" : "missing"}.`;
  $("#citationList").innerHTML = report.citations.suggestions
    .map(item => `<li>${escapeHtml(item.message)}</li>`)
    .join("");

  $("#sourceList").innerHTML = report.similarity.sourceMatches.length
    ? report.similarity.sourceMatches.map(source => `
      <li>
        <strong>${escapeHtml(source.title)}</strong>
        <span>${source.score}% match · lexical ${source.lexical}% · semantic ${source.semantic}%</span>
      </li>
    `).join("")
    : `<li>No source exceeded the demo match threshold.</li>`;
}

function debounce(callback, delay = 650) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

async function runLiveAnalysis() {
  const text = $("#liveText").value.trim();
  if (text.length < 20) {
    $("#liveStatus").textContent = "Type at least 20 characters to start.";
    $("#liveSimilarity").textContent = "--";
    $("#liveWriting").textContent = "--";
    $("#liveAi").textContent = "--";
    $("#liveCitations").textContent = "--";
    $("#liveHeatmap").textContent = "Type at least 20 characters to start.";
    $("#liveSuggestions").innerHTML = "";
    return;
  }

  $("#liveStatus").textContent = "Checking draft...";
  try {
    const report = await api("/analysis/full", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, filename: "live-draft.txt", userId: state.user?.id || "live-user" })
    });
    $("#liveSimilarity").textContent = `${report.similarity.overall}%`;
    $("#liveWriting").textContent = `${report.writing.readability}%`;
    $("#liveAi").textContent = `${report.aiContent.probability}%`;
    $("#liveCitations").textContent = report.citations.issues.length ? `${report.citations.issues.length} issue(s)` : "Clean";
    $("#liveHeatmap").innerHTML = markText(report.extractedText, report.similarity.segments);
    $("#liveSuggestions").innerHTML = [
      ...report.writing.suggestions.map(item => `${item.category}: ${item.message}`),
      ...report.citations.suggestions.map(item => `Citation: ${item.message}`),
      `AI-content signal: ${report.aiContent.label}. ${report.aiContent.disclaimer}`
    ].map(message => `<li>${escapeHtml(message)}</li>`).join("");
    $("#liveStatus").textContent = `Live check complete · ${report.wordCount} words`;
  } catch (error) {
    $("#liveStatus").textContent = error.message;
  }
}

async function uploadFile(file) {
  return uploadFileWithPersistence(file);
}

async function runLiveAnalysis() {
  const text = $("#liveText").value.trim();
  if (text.length < 20) {
    $("#liveStatus").textContent = "Type at least 20 characters to start.";
    $("#liveSimilarity").textContent = "--";
    $("#liveWriting").textContent = "--";
    $("#liveAi").textContent = "--";
    $("#liveCitations").textContent = "--";
    $("#liveHeatmap").textContent = "Type at least 20 characters to start.";
    $("#liveSuggestions").innerHTML = "";
    return;
  }

  $("#liveStatus").textContent = "Checking draft...";
  try {
    const result = await api("/analysis/full", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        filename: "live-draft.txt",
        userId: state.user?.id || "live-user",
        persist: Boolean(state.user)
      })
    });
    const report = result.report || result;
    $("#liveSimilarity").textContent = `${report.similarity.overall}%`;
    $("#liveWriting").textContent = `${report.writing.readability}%`;
    $("#liveAi").textContent = `${report.aiContent.probability}%`;
    $("#liveCitations").textContent = report.citations.issues.length ? `${report.citations.issues.length} issue(s)` : "Clean";
    $("#liveHeatmap").innerHTML = markText(report.extractedText, report.similarity.segments);
    $("#liveSuggestions").innerHTML = [
      ...report.writing.suggestions.map(item => `${item.category}: ${item.message}`),
      ...report.citations.suggestions.map(item => `Citation: ${item.message}`),
      `AI-content signal: ${report.aiContent.label}. ${report.aiContent.disclaimer}`
    ].map(message => `<li>${escapeHtml(message)}</li>`).join("");
    $("#liveStatus").textContent = `${result.persisted ? "Live check saved" : "Live check complete"} - ${report.wordCount} words`;
    if (result.persisted) await loadSubmissions();
  } catch (error) {
    $("#liveStatus").textContent = error.message;
  }
}

async function uploadFileWithPersistence(file) {
  const user = await ensureUser();
  const formData = new FormData();
  formData.append("userId", user.id);
  formData.append("document", file);

  setProgress("Uploading document", 28);
  const result = await api("/upload/document", {
    method: "POST",
    body: formData
  });
  setProgress("Report complete", 100);
  renderReport(result.report);
  await loadSubmissions();
  $("#documentInput").value = "";
  $("#fileName").textContent = "Drop PDF, DOCX, or TXT here";
  location.hash = "#report";
}

async function uploadSample() {
  await ensureUser();
  const file = new File([sampleText], "sample-integrity-draft.txt", { type: "text/plain" });
  $("#fileName").textContent = file.name;
  await uploadFile(file);
}

function renderSubmissions() {
  if (!state.user) {
    $("#submissionRows").innerHTML = `<tr><td colspan="6">Login to see your uploaded documents.</td></tr>`;
    return;
  }
  const risk = $("#riskFilter").value;
  const search = $("#searchInput").value.trim().toLowerCase();
  const rows = state.submissions.filter(item => {
    const report = item.report || {};
    const searchable = `${item.filename} ${item.userId} ${item.reportId}`.toLowerCase();
    const matchesSearch = !search || searchable.includes(search);
    const matchesRisk =
      risk === "all" ||
      (risk === "high" && report.similarity?.overall >= 35) ||
      (risk === "ai" && report.aiContent?.probability >= 55) ||
      (risk === "citation" && report.citations?.issues?.length);
    return matchesSearch && matchesRisk;
  });

  $("#submissionRows").innerHTML = rows.length
    ? rows.map(item => {
      const report = item.report;
      return `
        <tr>
          <td><button class="link-button" data-report="${report.id}">${escapeHtml(item.filename)}</button></td>
          <td>${new Date(item.timestamp).toLocaleString()}</td>
          <td><span class="pill ${riskClass(report.similarity.overall)}">${report.similarity.overall}%</span></td>
          <td><span class="pill ${riskClass(report.aiContent.probability)}">${report.aiContent.probability}%</span></td>
          <td>${report.citations.issues.length ? `${report.citations.issues.length} issue(s)` : "Clean"}</td>
          <td><span class="pill low-risk">${escapeHtml(item.status)}</span></td>
        </tr>
      `;
    }).join("")
    : `<tr><td colspan="6">No submissions match this view yet.</td></tr>`;

  document.querySelectorAll("[data-report]").forEach(button => {
    button.addEventListener("click", async () => {
      const report = await api(`/report/${button.dataset.report}`);
      renderReport(report);
      location.hash = "#report";
    });
  });
}

async function loadSubmissions() {
  if (!state.user) {
    state.submissions = [];
    renderSubmissions();
    return;
  }
  const result = await api(`/teacher/submissions?userId=${encodeURIComponent(state.user.id)}`);
  state.submissions = result.submissions;
  renderSubmissions();
}

async function loadStorageStatus() {
  try {
    const status = await api("/storage/status");
    const label = status.mode === "mongodb"
      ? `MongoDB connected · database ${status.mongodb.database}`
      : "JSON fallback active · check MongoDB connection";
    $("#storageStatus").textContent = label;
  } catch {
    $("#storageStatus").textContent = "Storage status unavailable";
  }
}

function bindUpload() {
  const input = $("#documentInput");
  const dropZone = $("#dropZone");

  input.addEventListener("change", () => {
    if (!state.user) {
      input.value = "";
      showLoginPanel("Please login first to choose a document.");
      return;
    }
    if (input.files[0]) $("#fileName").textContent = input.files[0].name;
  });

  ["dragenter", "dragover"].forEach(eventName => {
    dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach(eventName => {
    dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  });

  dropZone.addEventListener("drop", event => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (!state.user) {
      showLoginPanel("Please login first to drop a document.");
      return;
    }
    input.files = event.dataTransfer.files;
    $("#fileName").textContent = file.name;
  });

  $("#uploadForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.user) {
      showLoginPanel("Please login first to generate a report.");
      setProgress("Login required before upload", 0);
      return;
    }
    const file = input.files[0];
    if (!file) {
      setProgress("Choose a document first", 0);
      return;
    }
    try {
      setProgress("Preparing analysis", 12);
      await uploadFile(file);
    } catch (error) {
      setProgress(error.message, 0);
    }
  });
}

async function loadStorageStatus() {
  try {
    const status = await api("/storage/status");
    const label = status.mode === "mongodb"
      ? `MongoDB connected - database ${status.mongodb.database}`
      : `JSON fallback active - ${status.reason || "check MongoDB connection"}`;
    $("#storageStatus").textContent = label;
  } catch {
    $("#storageStatus").textContent = "Storage status unavailable";
  }
}

function init() {
  loadSession();
  setAuthMode("login");
  $("#authForm").addEventListener("submit", submitAuth);
  $("#loginTab").addEventListener("click", () => setAuthMode("login"));
  $("#registerTab").addEventListener("click", () => setAuthMode("register"));
  $("#loginToggle").addEventListener("click", () => {
    setAuthMode("login");
    showLoginPanel("Login with your registered email and password.");
  });
  $("#logoutButton").addEventListener("click", clearSession);
  $("#openLoginFromUpload").addEventListener("click", () => {
    setAuthMode("login");
    showLoginPanel("Login first, then upload your document.");
  });
  bindUpload();
  $("#sampleButton").addEventListener("click", () => uploadSample().catch(error => setProgress(error.message, 0)));
  $("#loadLiveSample").addEventListener("click", () => {
    $("#liveText").value = sampleText;
    runLiveAnalysis();
  });
  $("#liveText").addEventListener("input", debounce(runLiveAnalysis));
  $("#printButton").addEventListener("click", () => window.print());
  $("#refreshButton").addEventListener("click", () => loadSubmissions());
  $("#riskFilter").addEventListener("change", renderSubmissions);
  $("#searchInput").addEventListener("input", renderSubmissions);
  loadStorageStatus();
  loadSubmissions().catch(() => {});
}

document.addEventListener("DOMContentLoaded", init);
