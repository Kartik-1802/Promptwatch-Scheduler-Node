const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let state = null;
let session = null; // { email, role } | null
let editing = null; // { monitorIds:[...], days:Set }
const selected = new Set();

const MUTATE_ROLES = new Set(["editor", "admin", "super-admin"]);
const SETTINGS_ROLES = new Set(["admin", "super-admin"]);
const canMutate = () => session && MUTATE_ROLES.has(session.role);
const canSettings = () => session && SETTINGS_ROLES.has(session.role);
const isSuperAdmin = () => session && session.role === "super-admin";

// ---------- transport ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) showLogin();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, kind = "ok") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3500);
}

// ---------- rendering ----------
function fmtTime(ts) {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function describeSchedule(schedule) {
  if (!schedule) return null;
  const days = schedule.days.length === 7
    ? "every day"
    : schedule.days.map((d) => DAYS[d]).join(", ") || "no days";
  return `${schedule.startTime}–${schedule.endTime} · ${days}`;
}

function renderStats() {
  const monitors = state.monitors;
  const scheduled = monitors.filter((m) => m.schedule && m.schedule.enabled);
  const drift = monitors.filter((m) => m.desiredActive !== null && m.desiredActive !== m.active);
  const cards = [
    [monitors.filter((m) => m.active).length, "Active now"],
    [monitors.filter((m) => !m.active).length, "Inactive"],
    [monitors.length, "Monitors synced"],
    [scheduled.length, "On a schedule"],
    [state.projects.length, "Projects"],
    [drift.length, "Pending changes"],
  ];
  $("#stats").innerHTML = "";
  cards.forEach(([value, label]) => {
    const card = el("div", "stat");
    card.append(el("b", null, String(value)), el("span", null, label));
    $("#stats").append(card);
  });
}

function renderMonitors() {
  const list = $("#monitorList");
  const term = $("#search").value.trim().toLowerCase();
  const project = $("#projectFilter").value;
  const onlyScheduled = $("#scheduledOnly").checked;
  const onlyInactive = $("#inactiveOnly").checked;

  // Drop selections for monitors no longer in the synced set.
  const liveIds = new Set(state.monitors.map((m) => m.id));
  [...selected].forEach((id) => { if (!liveIds.has(id)) selected.delete(id); });

  const rows = state.monitors.filter((m) => {
    if (project && m.projectId !== project) return false;
    if (onlyScheduled && !m.schedule) return false;
    if (onlyInactive && m.active) return false;
    if (!term) return true;
    return `${m.name} ${m.projectName}`.toLowerCase().includes(term);
  });

  list.innerHTML = "";
  $("#emptyMonitors").classList.toggle("hidden", state.monitors.length > 0);
  renderBulkBar(rows);

  rows.forEach((m) => {
    const row = el("div", `mon${selected.has(m.id) ? " sel" : ""}`);

    const check = el("input");
    check.type = "checkbox";
    check.className = "rowcheck";
    check.checked = selected.has(m.id);
    check.onchange = () => {
      check.checked ? selected.add(m.id) : selected.delete(m.id);
      renderMonitors();
    };
    row.append(check);

    const lead = el("div", "lead");
    const name = el("div", "name");
    name.append(el("span", null, m.name));
    name.append(el("span", `badge ${m.active ? "on" : "off"}`, m.active ? "Active" : "Inactive"));
    if (m.schedule && m.schedule.enabled) {
      name.append(el("span", "badge auto", m.inWindow ? "In window" : "Outside window"));
    } else if (m.schedule) {
      name.append(el("span", "badge", "Schedule paused"));
    }
    if (m.staleSince) name.append(el("span", "badge warnb", "Sync issue"));
    lead.append(name);

    const bits = [m.projectName, `${m.promptCount ?? 0} prompts`, (m.models || []).length + " models"];
    if (m.countryCode) bits.push(`${m.countryCode}/${m.languageCode || "—"}`);
    lead.append(el("div", "meta", bits.join(" · ")));
    row.append(lead);

    const sched = el("div", "sched");
    if (m.schedule) {
      const line = el("div");
      line.append(el("b", null, describeSchedule(m.schedule)));
      sched.append(line);
      if (m.nextTransition) {
        const when = new Date(m.nextTransition.at);
        sched.append(el("div", null,
          `Next: ${m.nextTransition.to} at ${when.toLocaleString([], {
            weekday: "short", hour: "2-digit", minute: "2-digit" })}`));
      }
    } else {
      sched.append(el("div", null, "No schedule — runs manually"));
    }
    row.append(sched);

    const actions = el("div", "actions");
    const toggle = el("button", "btn", m.active ? "Deactivate" : "Activate");
    toggle.disabled = !canMutate();
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        const res = await api(`/api/monitors/${m.id}/active`, {
          method: "POST", body: { active: !m.active } });
        apply(res.state);
        toast(`${m.name} is now ${!m.active ? "active" : "inactive"}`);
      } catch (err) { toast(err.message, "err"); }
      finally { toggle.disabled = !canMutate(); }
    };
    const edit = el("button", "btn primary", m.schedule ? "Edit schedule" : "Schedule");
    edit.disabled = !canMutate();
    edit.onclick = () => openEditor(m);
    actions.append(toggle, edit);
    row.append(actions);

    list.append(row);
  });
}

function renderBulkBar(visibleRows) {
  $("#bulkBar").classList.toggle("hidden", selected.size === 0);
  $("#selectedCount").textContent = `${selected.size} selected`;
  const visibleIds = visibleRows.map((m) => m.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selectAll = $("#selectAll");
  selectAll.checked = allVisibleSelected;
  selectAll.onchange = () => {
    if (selectAll.checked) visibleIds.forEach((id) => selected.add(id));
    else visibleIds.forEach((id) => selected.delete(id));
    renderMonitors();
  };
}

function renderProjectFilter() {
  const select = $("#projectFilter");
  const current = select.value;
  select.innerHTML = '<option value="">All projects</option>';
  state.projects.forEach((p) => {
    const option = el("option", null, p.name);
    option.value = p.id;
    select.append(option);
  });
  select.value = current;
}

function renderTop() {
  const now = new Date(state.serverNow);
  $("#clock").textContent = `${state.settings.timezone} · ${now.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit" })}`;
  const on = state.settings.schedulerEnabled && state.settings.hasApiKey;
  $("#tickState").textContent = on
    ? `Automation on · last check ${fmtTime(state.lastTickAt)}`
    : (state.settings.hasApiKey ? "Automation paused" : "No API key");
  document.querySelector(".dot").classList.toggle("off", !on);
}

function renderSettings() {
  const s = state.settings;
  $("#keyState").textContent = s.hasApiKey
    ? `Key saved: ${s.apiKeyMask} · last sync ${state.lastSyncAt ? fmtTime(state.lastSyncAt) : "never"}`
    : "No API key saved yet.";
  if (document.activeElement !== $("#timezone")) $("#timezone").value = s.timezone;
  if (document.activeElement !== $("#tickSeconds")) $("#tickSeconds").value = s.tickSeconds;
  $("#schedulerEnabled").checked = s.schedulerEnabled;
}

function apply(next) {
  state = next;
  renderTop();
  renderStats();
  renderProjectFilter();
  renderMonitors();
  renderSettings();
  applyRoleUI();
}

const MUTATE_BUTTON_IDS = ["syncBtn", "runNow", "addByIdBtn", "adoptSave",
  "bulkActivate", "bulkDeactivate", "bulkSchedule", "bulkClearSchedule"];
const SETTINGS_INPUT_IDS = ["apiKey", "saveKey", "testKey", "clearKey",
  "timezone", "tickSeconds", "schedulerEnabled", "saveScheduler"];

function applyRoleUI() {
  MUTATE_BUTTON_IDS.forEach((id) => { const e = $(`#${id}`); if (e) e.disabled = !canMutate(); });
  SETTINGS_INPUT_IDS.forEach((id) => { const e = $(`#${id}`); if (e) e.disabled = !canSettings(); });
  $("#teamTabBtn").classList.toggle("hidden", !isSuperAdmin());
  $("#whoami").textContent = session ? `${session.email} · ${session.role}` : "";
}

// ---------- usage + logs ----------
async function loadUsage() {
  const usage = await api("/api/usage");
  $("#uLastHour").textContent = usage.lastHour;
  $("#u24").textContent = usage.last24h;
  $("#uErr").textContent = usage.errors24h;

  const peak = Math.max(1, ...usage.series.map((b) => b.total));
  const chart = $("#usageChart");
  chart.innerHTML = "";
  usage.series.forEach((bucket) => {
    const label = new Date(bucket.hour * 1000).toLocaleTimeString([], { hour: "2-digit" });
    const bar = el("div", "bar");
    bar.title = `${label} — ${bucket.total} calls, ${bucket.errors} failed, avg ${bucket.avgMs}ms`;
    const ok = el("i");
    ok.style.height = `${((bucket.total - bucket.errors) / peak) * 100}%`;
    const bad = el("i", "err");
    bad.style.height = `${(bucket.errors / peak) * 100}%`;
    bar.append(bad, ok);
    chart.append(bar);
  });

  $("#endpointRows").innerHTML = "";
  usage.byEndpoint.forEach((row) => {
    const tr = el("tr");
    tr.append(el("td", null, row.endpoint), el("td", null, String(row.count)));
    $("#endpointRows").append(tr);
  });
}

async function loadLogs() {
  const { logs } = await api("/api/logs");
  const level = $("#logLevel").value;
  const term = $("#logSearch").value.trim().toLowerCase();
  const list = $("#logList");
  list.innerHTML = "";
  const rows = logs.filter((l) =>
    (!level || l.level === level) && (!term || l.message.toLowerCase().includes(term)));
  if (!rows.length) { list.append(el("div", "logrow", "No log entries yet.")); return; }
  rows.forEach((entry) => {
    const row = el("div", "logrow");
    const msgClass = entry.kind === "activate" ? "msg activate"
      : entry.kind === "deactivate" ? "msg deactivate" : "msg";
    row.append(
      el("span", "t", new Date(entry.ts * 1000).toLocaleString([], {
        month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })),
      el("span", `lv ${entry.level}`, entry.level),
      el("span", "user", entry.user || "System"),
      el("span", msgClass, entry.message));
    list.append(row);
  });
}

// ---------- schedule editor ----------
function openEditor(monitor) {
  const schedule = monitor.schedule || { enabled: true, days: [0, 1, 2, 3, 4], startTime: "09:00", endTime: "17:00" };
  editing = { monitorIds: [monitor.id], days: new Set(schedule.days) };
  $("#modalTitle").textContent = monitor.name;
  $("#modalSub").textContent = `${monitor.projectName} · currently ${monitor.active ? "active" : "inactive"}`;
  $("#schEnabled").checked = schedule.enabled;
  $("#schStart").value = schedule.startTime;
  $("#schEnd").value = schedule.endTime;
  $("#schDelete").classList.toggle("hidden", !monitor.schedule);
  renderDays();
  updateHint();
  $("#modal").classList.remove("hidden");
}

function openBulkEditor() {
  if (!selected.size) return toast("Select at least one monitor first", "err");
  const ids = [...selected];
  const monitors = state.monitors.filter((m) => ids.includes(m.id));
  editing = { monitorIds: ids, days: new Set([0, 1, 2, 3, 4]) };
  $("#modalTitle").textContent = `${ids.length} monitors selected`;
  const projects = new Set(monitors.map((m) => m.projectName));
  $("#modalSub").textContent = projects.size === 1
    ? `All in ${[...projects][0]} · this replaces each monitor's existing schedule`
    : `Across ${projects.size} projects · this replaces each monitor's existing schedule`;
  $("#schEnabled").checked = true;
  $("#schStart").value = "09:00";
  $("#schEnd").value = "17:00";
  $("#schDelete").classList.add("hidden");
  renderDays();
  updateHint();
  $("#modal").classList.remove("hidden");
}

function renderDays() {
  const picker = $("#dayPicker");
  picker.innerHTML = "";
  DAYS.forEach((label, index) => {
    const button = el("div", `day${editing.days.has(index) ? " sel" : ""}`, label);
    button.onclick = () => {
      editing.days.has(index) ? editing.days.delete(index) : editing.days.add(index);
      renderDays();
      updateHint();
    };
    picker.append(button);
  });
}

function updateHint() {
  const start = $("#schStart").value, end = $("#schEnd").value;
  const days = [...editing.days].sort().map((d) => DAYS[d]).join(", ") || "no days";
  if (start === end) {
    $("#windowHint").textContent = `Active all day on ${days}, inactive otherwise.`;
  } else if (start > end) {
    $("#windowHint").textContent =
      `Activates at ${start} on ${days} and deactivates at ${end} the next morning.`;
  } else {
    $("#windowHint").textContent =
      `Activates at ${start} and deactivates at ${end} on ${days}. Inactive at all other times.`;
  }
}

async function saveSchedule() {
  const body = {
    enabled: $("#schEnabled").checked,
    days: [...editing.days],
    startTime: $("#schStart").value,
    endTime: $("#schEnd").value,
  };
  const bulk = editing.monitorIds.length > 1;
  try {
    const res = bulk
      ? await api("/api/schedules/bulk", { method: "PUT", body: { ...body, monitorIds: editing.monitorIds } })
      : await api(`/api/schedules/${editing.monitorIds[0]}`, { method: "PUT", body });
    apply(res.state);
    $("#modal").classList.add("hidden");
    toast(bulk ? `Schedule applied to ${editing.monitorIds.length} monitor(s)` : "Schedule saved and applied");
    loadLogs();
  } catch (err) { toast(err.message, "err"); }
}

// ---------- team ----------
async function loadTeam() {
  if (!isSuperAdmin()) return;
  const { users } = await api("/api/users");
  const list = $("#teamList");
  list.innerHTML = "";
  users.forEach((u) => {
    const row = el("div", "team-row");

    const lead = el("div", "lead");
    const emailLine = el("div", "email");
    emailLine.append(el("span", null, u.email));
    emailLine.append(el("span", `role ${u.role}`, u.role));
    if (!u.active) emailLine.append(el("span", "badge off", "Deactivated"));
    lead.append(emailLine);
    const created = u.createdAt ? new Date(u.createdAt * 1000).toLocaleDateString() : "—";
    const lastLogin = u.lastLoginAt
      ? new Date(u.lastLoginAt * 1000).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "never";
    lead.append(el("div", "meta", `Added ${created} · Last login ${lastLogin}`));
    row.append(lead);

    const roleSelect = el("select", "input");
    ["viewer", "editor", "admin", "super-admin"].forEach((r) => {
      const opt = el("option", null, r);
      opt.value = r;
      if (r === u.role) opt.selected = true;
      roleSelect.append(opt);
    });
    roleSelect.disabled = u.role === "super-admin";
    roleSelect.onchange = async () => {
      try {
        await api(`/api/users/${u.id}`, { method: "PUT", body: { role: roleSelect.value } });
        toast(`${u.email} is now ${roleSelect.value}`);
      } catch (err) { toast(err.message, "err"); }
      loadTeam();
    };
    row.append(roleSelect);

    const actions = el("div", "actions");
    const resetBtn = el("button", "btn", "Reset password");
    resetBtn.onclick = async () => {
      const pw = prompt(`New password for ${u.email} (min 8 characters):`);
      if (!pw) return;
      try {
        await api(`/api/users/${u.id}`, { method: "PUT", body: { password: pw } });
        toast("Password reset");
      } catch (err) { toast(err.message, "err"); }
    };
    actions.append(resetBtn);

    if (u.role !== "super-admin") {
      const toggleBtn = el("button", "btn", u.active ? "Deactivate" : "Activate");
      toggleBtn.onclick = async () => {
        try {
          await api(`/api/users/${u.id}`, { method: "PUT", body: { active: !u.active } });
          toast(`${u.email} ${!u.active ? "activated" : "deactivated"}`);
        } catch (err) { toast(err.message, "err"); }
        loadTeam();
      };
      const removeBtn = el("button", "btn danger", "Remove");
      removeBtn.onclick = async () => {
        if (!confirm(`Remove ${u.email}? This can't be undone.`)) return;
        try {
          await api(`/api/users/${u.id}`, { method: "DELETE" });
          toast("Member removed");
        } catch (err) { toast(err.message, "err"); }
        loadTeam();
      };
      actions.append(toggleBtn, removeBtn);
    }
    row.append(actions);
    list.append(row);
  });
}

$("#inviteBtn").onclick = async () => {
  $("#inviteError").textContent = "";
  const email = $("#inviteEmail").value.trim();
  try {
    await api("/api/users", { method: "POST", body: {
      email, role: $("#inviteRole").value, password: $("#invitePassword").value } });
    $("#inviteEmail").value = "";
    $("#invitePassword").value = "";
    toast(`Invited ${email}`);
    loadTeam();
  } catch (err) { $("#inviteError").textContent = err.message; }
};

// ---------- account ----------
$("#changePasswordBtn").onclick = async () => {
  const current = $("#curPassword").value;
  const next1 = $("#newPassword").value;
  const next2 = $("#newPassword2").value;
  if (next1 !== next2) return toast("New passwords don't match", "err");
  try {
    await api("/api/auth/change-password", { method: "POST",
      body: { currentPassword: current, newPassword: next1 } });
    $("#curPassword").value = "";
    $("#newPassword").value = "";
    $("#newPassword2").value = "";
    toast("Password changed");
  } catch (err) { toast(err.message, "err"); }
};

// ---------- auth ----------
function showLogin() {
  session = null;
  $("#appShell").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
}

function showApp() {
  $("#loginScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
}

$("#loginBtn").onclick = async () => {
  $("#loginError").textContent = "";
  try {
    const res = await api("/api/auth/login", { method: "POST", body: {
      email: $("#loginEmail").value.trim(), password: $("#loginPassword").value } });
    session = res.user;
    $("#loginPassword").value = "";
    showApp();
    await initAfterLogin();
  } catch (err) { $("#loginError").textContent = err.message; }
};
$("#loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#loginBtn").click(); });
$("#loginEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#loginPassword").focus(); });

$("#logoutBtn").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (err) { /* ignore */ }
  showLogin();
};

// ---------- wiring ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    ["monitors", "logs", "settings", "team"].forEach((name) =>
      $(`#tab-${name}`).classList.toggle("hidden", name !== tab.dataset.tab));
    if (tab.dataset.tab === "logs") loadLogs();
    if (tab.dataset.tab === "settings") loadUsage();
    if (tab.dataset.tab === "team") loadTeam();
  };
});

$("#search").oninput = renderMonitors;
$("#projectFilter").onchange = renderMonitors;
$("#scheduledOnly").onchange = renderMonitors;
$("#inactiveOnly").onchange = renderMonitors;
$("#logLevel").onchange = loadLogs;
$("#logSearch").oninput = loadLogs;
$("#schStart").oninput = updateHint;
$("#schEnd").oninput = updateHint;
$("#schCancel").onclick = () => $("#modal").classList.add("hidden");
$("#schSave").onclick = saveSchedule;
$("#schDelete").onclick = async () => {
  try {
    const res = await api(`/api/schedules/${editing.monitorIds[0]}`, { method: "DELETE" });
    apply(res.state);
    $("#modal").classList.add("hidden");
    toast("Schedule removed");
  } catch (err) { toast(err.message, "err"); }
};

$("#bulkSchedule").onclick = openBulkEditor;

$("#bulkClearSchedule").onclick = async () => {
  if (!selected.size) return;
  if (!confirm(`Remove schedules from ${selected.size} monitor(s)?`)) return;
  try {
    const res = await api("/api/schedules/bulk", { method: "DELETE", body: { monitorIds: [...selected] } });
    apply(res.state);
    toast(`Schedules removed from ${selected.size} monitor(s)`);
  } catch (err) { toast(err.message, "err"); }
};

async function bulkSetActive(active) {
  if (!selected.size) return;
  try {
    const res = await api("/api/monitors/active-bulk", { method: "POST",
      body: { monitorIds: [...selected], active } });
    apply(res.state);
    const failedCount = res.failed.length;
    toast(failedCount
      ? `${res.changed.length} updated, ${failedCount} failed`
      : `${res.changed.length} monitor(s) ${active ? "activated" : "deactivated"}`,
      failedCount ? "err" : "ok");
  } catch (err) { toast(err.message, "err"); }
}
$("#bulkActivate").onclick = () => bulkSetActive(true);
$("#bulkDeactivate").onclick = () => bulkSetActive(false);

$("#syncBtn").onclick = async () => {
  const button = $("#syncBtn");
  button.disabled = true; button.textContent = "Syncing…";
  try {
    const res = await api("/api/sync", { method: "POST" });
    apply(res.state);
    const { projects, monitors, errors } = res.summary;
    toast(`Synced ${projects} project(s), ${monitors} monitor(s)`, errors.length ? "err" : "ok");
  } catch (err) { toast(err.message, "err"); }
  finally { button.disabled = false; button.textContent = "Sync"; }
};

$("#addByIdBtn").onclick = () => {
  const select = $("#adoptProject");
  select.innerHTML = state.projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  $("#adoptRow").classList.toggle("hidden");
};
$("#adoptCancel").onclick = () => $("#adoptRow").classList.add("hidden");
$("#adoptSave").onclick = async () => {
  const ids = $("#adoptIds").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return toast("Paste at least one monitor ID", "err");
  try {
    const res = await api("/api/monitors/adopt", { method: "POST", body: {
      projectId: $("#adoptProject").value, monitorIds: ids }});
    apply(res.state);
    const failedCount = res.failed.length;
    $("#adoptResult").textContent = failedCount
      ? `Added ${res.added}, failed: ${res.failed.map((f) => f.id.slice(0, 8)).join(", ")}`
      : "";
    if (res.added) {
      $("#adoptIds").value = failedCount ? res.failed.map((f) => f.id).join("\n") : "";
      toast(`Added ${res.added} monitor(s)${failedCount ? `, ${failedCount} failed` : ""}`,
        failedCount ? "err" : "ok");
      if (!failedCount) $("#adoptRow").classList.add("hidden");
    } else {
      toast(`Could not add any monitors: ${res.failed[0]?.message || "unknown error"}`, "err");
    }
  } catch (err) { toast(err.message, "err"); }
};

$("#runNow").onclick = async () => {
  try {
    const res = await api("/api/scheduler/run", { method: "POST" });
    apply(res.state);
    toast(`Scheduler applied ${res.changes.length} change(s)`);
  } catch (err) { toast(err.message, "err"); }
};

$("#saveKey").onclick = async () => {
  const key = $("#apiKey").value.trim();
  if (!key) return toast("Paste a key first", "err");
  try {
    await api("/api/settings", { method: "POST", body: { apiKey: key } });
    $("#apiKey").value = "";
    const res = await api("/api/sync", { method: "POST" });
    apply(res.state);
    toast(`Key saved · synced ${res.summary.monitors} monitor(s)`);
  } catch (err) { toast(err.message, "err"); refresh(); }
};

$("#testKey").onclick = async () => {
  try {
    const key = $("#apiKey").value.trim();
    const res = await api("/api/settings/test", { method: "POST", body: key ? { apiKey: key } : {} });
    toast(`Key works — ${res.projects} project(s) visible`);
  } catch (err) { toast(err.message, "err"); }
};

$("#clearKey").onclick = async () => {
  if (!confirm("Remove the saved API key and clear cached projects/monitors?")) return;
  const res = await api("/api/settings/apikey", { method: "DELETE" });
  apply(res.state);
  toast("API key removed");
};

$("#saveScheduler").onclick = async () => {
  try {
    await api("/api/settings", { method: "POST", body: {
      timezone: $("#timezone").value.trim(),
      tickSeconds: Number($("#tickSeconds").value),
      schedulerEnabled: $("#schedulerEnabled").checked,
    }});
    await refresh();
    toast("Scheduler settings saved");
  } catch (err) { toast(err.message, "err"); }
};

async function refresh() { apply(await api("/api/state")); }

let pollingStarted = false;

async function initAfterLogin() {
  applyRoleUI();
  const { timezones } = await api("/api/timezones");
  $("#tzlist").innerHTML = timezones.map((tz) => `<option value="${tz}">`).join("");
  await refresh();
  await loadUsage();
  if (isSuperAdmin()) loadTeam();

  if (!pollingStarted) {
    pollingStarted = true;
    setInterval(async () => {
      if (!session) return;
      try {
        await refresh();
        if (!$("#tab-logs").classList.contains("hidden") && $("#autoRefresh").checked) loadLogs();
        if (!$("#tab-settings").classList.contains("hidden")) loadUsage();
        if (!$("#tab-team").classList.contains("hidden")) loadTeam();
      } catch (err) { /* likely a 401 — api() already triggered the login screen */ }
    }, 15000);
  }
}

(async function boot() {
  const { user } = await api("/api/auth/session");
  if (user) {
    session = user;
    showApp();
    await initAfterLogin();
  } else {
    showLogin();
  }
})();
