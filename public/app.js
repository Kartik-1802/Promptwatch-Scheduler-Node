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
let activeProjectId = null; // null = folder grid, "__all__" = every monitor, or a real project id
let editing = null; // { mode: 'single', monitorId } | { mode: 'bulk', monitorIds: [...] }
const selected = new Set();

const MUTATE_ROLES = new Set(["editor", "admin", "super-admin"]);
const SETTINGS_ROLES = new Set(["admin", "super-admin"]);
const TEAM_ROLES = new Set(["admin", "super-admin"]);
const canMutate = () => session && MUTATE_ROLES.has(session.role);
const canSettings = () => session && SETTINGS_ROLES.has(session.role);
const canManageTeam = () => session && TEAM_ROLES.has(session.role);
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

// ---------- rendering helpers ----------
function fmtTime(ts) {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function describeBlock(block) {
  return `${DAYS[block.startDay]} ${block.startTime} → ${DAYS[block.endDay]} ${block.endTime}`;
}

function monitorsInScope(projectId) {
  if (!state) return [];
  if (projectId === "__all__" || !projectId) return state.monitors;
  return state.monitors.filter((m) => m.projectId === projectId);
}

function renderStats() {
  const monitors = monitorsInScope(activeProjectId);
  const scheduled = monitors.filter((m) => m.blocks.length > 0);
  const drift = monitors.filter((m) => m.desiredActive !== null && m.desiredActive !== m.active);
  const activeCount = monitors.filter((m) => m.active).length;

  // One primary metric (active/total already implies "inactive") plus a
  // compact secondary row, instead of several same-weight cards that
  // partly restate each other.
  const primary = $("#statPrimary");
  primary.innerHTML = "";
  primary.append(el("b", null, `${activeCount}/${monitors.length}`), el("span", null, "monitors active"));

  const secondary = $("#statSecondary");
  secondary.innerHTML = "";
  [
    [scheduled.length, "on a schedule"],
    [state.projects.length, "projects"],
    [drift.length, "pending changes"],
  ].forEach(([value, label]) => {
    const chip = el("div", "stat-chip");
    chip.append(el("b", null, String(value)), el("span", null, label));
    secondary.append(chip);
  });
}

// ---------- folder view ----------
function renderFolders() {
  const grid = $("#folderGrid");
  const term = $("#folderSearch").value.trim().toLowerCase();
  grid.innerHTML = "";

  const byProject = new Map();
  state.monitors.forEach((m) => {
    if (!byProject.has(m.projectId)) byProject.set(m.projectId, []);
    byProject.get(m.projectId).push(m);
  });

  const visibleProjects = state.projects.filter((p) => !term || p.name.toLowerCase().includes(term));
  $("#emptyFolders").classList.toggle("hidden", state.projects.length > 0);

  if (!term) {
    const allCard = el("div", "folder-card call");
    allCard.append(el("div", "ficon", "▦"));
    allCard.append(el("div", "fname", "All projects"));
    allCard.append(el("div", "fmeta", `${state.monitors.length} monitor(s) total`));
    const counts = el("div", "fcounts");
    counts.append(el("span", "fchip", `${state.monitors.filter((m) => m.active).length} active`));
    allCard.append(counts);
    allCard.onclick = () => openProject("__all__");
    grid.append(allCard);
  }

  visibleProjects.forEach((p) => {
    const monitors = byProject.get(p.id) || [];
    const card = el("div", "folder-card");
    card.append(el("div", "ficon", "📁"));
    card.append(el("div", "fname", p.name));
    card.append(el("div", "fmeta", monitors.length === 1 ? "1 monitor" : `${monitors.length} monitors`));
    const counts = el("div", "fcounts");
    counts.append(el("span", "fchip", `${monitors.filter((m) => m.active).length} active`));
    counts.append(el("span", "fchip", `${monitors.filter((m) => m.blocks.length > 0).length} scheduled`));
    card.append(counts);
    card.onclick = () => openProject(p.id);
    grid.append(card);
  });
}

function openProject(id) {
  activeProjectId = id;
  selected.clear();
  $("#folderView").classList.add("hidden");
  $("#projectView").classList.remove("hidden");
  const project = state.projects.find((p) => p.id === id);
  $("#projectViewTitle").textContent = id === "__all__" ? "All monitors" : (project ? project.name : "Monitors");
  $("#projectViewIcon").textContent = id === "__all__" ? "▦" : "📁";
  $("#pageTitle").textContent = id === "__all__" ? "All monitors" : (project ? project.name : "Monitors");
  $("#pageSub").textContent = "Schedule, activate, or bulk-manage the monitors below.";
  renderStats();
  renderMonitors();
}

function backToFolders() {
  activeProjectId = null;
  selected.clear();
  $("#projectView").classList.add("hidden");
  $("#folderView").classList.remove("hidden");
  $("#pageTitle").textContent = "Projects";
  $("#pageSub").textContent = "Pick a project to see its monitors, or manage everything at once.";
  renderStats();
  renderFolders();
}

function renderMonitors() {
  if (activeProjectId === null) return; // folder grid is shown instead
  const list = $("#monitorList");
  const term = $("#search").value.trim().toLowerCase();
  const onlyScheduled = $("#scheduledOnly").checked;
  const onlyInactive = $("#inactiveOnly").checked;

  const scope = monitorsInScope(activeProjectId);
  const liveIds = new Set(scope.map((m) => m.id));
  [...selected].forEach((id) => { if (!liveIds.has(id)) selected.delete(id); });

  const rows = scope.filter((m) => {
    if (onlyScheduled && !m.blocks.length) return false;
    if (onlyInactive && m.active) return false;
    if (!term) return true;
    return `${m.name} ${m.projectName}`.toLowerCase().includes(term);
  });

  list.innerHTML = "";
  $("#emptyMonitors").classList.toggle("hidden", rows.length > 0);
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
    if (m.blocks.length) {
      name.append(el("span", "badge auto", m.inWindow ? "In window" : "Outside window"));
    }
    if (m.staleSince) name.append(el("span", "badge warnb", "Sync issue"));
    lead.append(name);

    const bits = [m.projectName, `${m.promptCount ?? 0} prompts`, (m.models || []).length + " models"];
    if (m.countryCode) bits.push(`${m.countryCode}/${m.languageCode || "—"}`);
    lead.append(el("div", "meta", bits.join(" · ")));
    row.append(lead);

    const sched = el("div", "sched");
    if (m.blocks.length) {
      m.blocks.slice(0, 2).forEach((b) => sched.append(el("div", null, describeBlock(b))));
      if (m.blocks.length > 2) sched.append(el("div", "muted", `+${m.blocks.length - 2} more block(s)`));
      if (m.nextTransition) {
        const when = new Date(m.nextTransition.at);
        sched.append(el("div", "muted",
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
    const edit = el("button", "btn primary", m.blocks.length ? "Manage schedule" : "Schedule");
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

function renderTop() {
  const on = state.settings.schedulerEnabled && state.settings.hasApiKey;
  const label = on
    ? `Automation on · last check ${fmtTime(state.lastTickAt)}`
    : (state.settings.hasApiKey ? "Automation paused" : "No API key");
  $("#tickLabel").textContent = label;
  $("#tickState .dot").classList.toggle("off", !on);
  $("#rightAutomation").textContent = label;
}

function renderRightRail() {
  if (!session) return;
  $("#avatarInitial").textContent = session.email.slice(0, 1).toUpperCase();
  $("#whoami").textContent = session.email;
  $("#whoRole").textContent = session.role;
  const monitors = state.monitors;
  const wrap = $("#rightStats");
  wrap.innerHTML = "";
  const rows = [
    [`${monitors.filter((m) => m.active).length}/${monitors.length}`, "monitors active"],
    [monitors.filter((m) => m.blocks.length > 0).length, "on a schedule"],
    [state.projects.length, "projects synced"],
  ];
  rows.forEach(([value, label]) => {
    const row = el("div", "small muted");
    row.innerHTML = `<b style="color:var(--ink)">${value}</b> ${label}`;
    wrap.append(row);
  });
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
  if (activeProjectId === null) renderFolders(); else renderMonitors();
  renderStats();
  renderSettings();
  renderRightRail();
  applyRoleUI();
}

const MUTATE_BUTTON_IDS = ["syncBtn", "runNow", "addByIdBtn", "adoptSave",
  "bulkActivate", "bulkDeactivate", "bulkSchedule", "bulkClearSchedule"];
const SETTINGS_INPUT_IDS = ["apiKey", "saveKey", "testKey", "clearKey",
  "timezone", "tickSeconds", "schedulerEnabled", "saveScheduler"];

function applyRoleUI() {
  MUTATE_BUTTON_IDS.forEach((id) => { const e = $(`#${id}`); if (e) e.disabled = !canMutate(); });
  SETTINGS_INPUT_IDS.forEach((id) => { const e = $(`#${id}`); if (e) e.disabled = !canSettings(); });
  $("#teamTabBtn").classList.toggle("hidden", !canManageTeam());
  $("#whoami").textContent = session ? session.email : "";
}

// ---------- usage + logs ----------
async function loadUsage() {
  const usage = await api("/api/usage");
  $("#uLastHour").textContent = usage.lastHour;
  $("#u24").textContent = usage.last24h;
  $("#uErr").textContent = usage.errors24h;

  const peak = Math.max(1, ...usage.series.map((b) => b.total));
  const chart = $("#usageChart");
  const axis = $("#usageAxis");
  chart.innerHTML = "";
  axis.innerHTML = "";
  // 24 hourly buckets is too many labels to show at once, so only every
  // 3rd hour gets one — the bars themselves stay one-per-hour, and hovering
  // any bar still shows its exact hour, count, and failures via the tooltip.
  const labelEvery = 3;
  usage.series.forEach((bucket, i) => {
    const label = new Date(bucket.hour * 1000).toLocaleTimeString([], { hour: "2-digit" });
    const bar = el("div", "bar");
    bar.title = `${label} — ${bucket.total} calls, ${bucket.errors} failed, avg ${bucket.avgMs}ms`;
    const ok = el("i");
    ok.style.height = `${((bucket.total - bucket.errors) / peak) * 100}%`;
    const bad = el("i", "err");
    bad.style.height = `${(bucket.errors / peak) * 100}%`;
    bar.append(bad, ok);
    chart.append(bar);
    axis.append(el("span", null, i % labelEvery === 0 ? label : ""));
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

// ---------- schedule editor (multiple time blocks per monitor) ----------
// Structure/logic ported from the time-block-scheduler reference: a block is
// a single (startDay,startTime) -> (endDay,endTime) range, not a set of
// repeated weekdays. Days are 0=Mon..6=Sun to match this app's convention
// (the reference used 1-7); everything else — minute math, the "end must be
// later than start" rule, the live preview, the blocks table — mirrors it.
function currentMonitor(id) {
  return state.monitors.find((m) => m.id === id) || null;
}

function blockMinutes(day, time) {
  const [h, m] = time.split(":").map(Number);
  return day * 1440 + h * 60 + m;
}

function durationText(startMin, endMin) {
  let diff = endMin - startMin;
  const daysCount = Math.floor(diff / 1440);
  diff %= 1440;
  const hours = Math.floor(diff / 60);
  const mins = diff % 60;
  const parts = [];
  if (daysCount) parts.push(`${daysCount}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  return parts.length ? parts.join(" ") : "0m";
}

function populateBlockDaySelects() {
  const options = DAYS.map((label, i) => `<option value="${i}">${label}</option>`).join("");
  $("#blockStartDay").innerHTML = options;
  $("#blockEndDay").innerHTML = options;
  $("#blockStartDay").value = "0";
  $("#blockEndDay").value = "0";
}

function resetBlockForm() {
  populateBlockDaySelects();
  $("#schStart").value = "09:00";
  $("#schEnd").value = "17:00";
  $("#blockError").textContent = "";
  $("#blockPreview").classList.add("hidden");
}

function updateBlockPreview() {
  $("#blockError").textContent = "";
  const startDay = Number($("#blockStartDay").value), endDay = Number($("#blockEndDay").value);
  const startTime = $("#schStart").value, endTime = $("#schEnd").value;
  if (!startTime || !endTime) return;
  const start = blockMinutes(startDay, startTime), end = blockMinutes(endDay, endTime);
  const preview = $("#blockPreview");
  if (end <= start) {
    preview.classList.add("hidden");
    return;
  }
  preview.innerHTML = `<b>Block:</b> ${DAYS[startDay]} ${startTime} → ${DAYS[endDay]} ${endTime}
    &nbsp;·&nbsp; Duration: <b>${durationText(start, end)}</b>
    &nbsp;·&nbsp; Start = <b>ON</b>, End = <b>OFF</b>`;
  preview.classList.remove("hidden");
}

function openEditor(monitor) {
  editing = { mode: "single", monitorId: monitor.id };
  $("#modalTitle").textContent = monitor.name;
  $("#modalSub").textContent = `${monitor.projectName} · currently ${monitor.active ? "active" : "inactive"}. Blocks on this monitor can't overlap or touch each other.`;
  $("#blockTableSection").classList.remove("hidden");
  $("#schDeleteAll").classList.toggle("hidden", monitor.blocks.length === 0);
  resetBlockForm();
  renderBlockTable();
  $("#modal").classList.remove("hidden");
}

function openBulkEditor() {
  if (!selected.size) return toast("Select at least one monitor first", "err");
  const ids = [...selected];
  const monitors = state.monitors.filter((m) => ids.includes(m.id));
  editing = { mode: "bulk", monitorIds: ids };
  $("#modalTitle").textContent = `${ids.length} monitors selected`;
  const projects = new Set(monitors.map((m) => m.projectName));
  $("#modalSub").textContent = (projects.size === 1
    ? `All in ${[...projects][0]}. `
    : `Across ${projects.size} projects. `)
    + "Adds one new time block to each — any monitor where it would overlap an existing block is skipped.";
  $("#blockTableSection").classList.add("hidden");
  $("#schDeleteAll").classList.add("hidden");
  resetBlockForm();
  $("#modal").classList.remove("hidden");
}

function renderBlockTable() {
  const monitor = currentMonitor(editing.monitorId);
  const blocks = [...monitor.blocks].sort((a, b) => blockMinutes(a.startDay, a.startTime) - blockMinutes(b.startDay, b.startTime));
  $("#blockCount").textContent = `${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
  const wrap = $("#blockTableWrap");
  if (!blocks.length) {
    wrap.innerHTML = '<div class="block-empty">No time blocks yet — this monitor runs manually.</div>';
    return;
  }
  wrap.innerHTML = "";
  const table = el("table", "block-table");
  table.innerHTML = `<thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Triggers</th><th></th></tr></thead>`;
  const tbody = el("tbody");
  blocks.forEach((block) => {
    const start = blockMinutes(block.startDay, block.startTime), end = blockMinutes(block.endDay, block.endTime);
    const tr = el("tr");
    tr.innerHTML = `
      <td><b>${DAYS[block.startDay]}</b><br><span class="btime">${block.startTime}</span></td>
      <td><b>${DAYS[block.endDay]}</b><br><span class="btime">${block.endTime}</span></td>
      <td class="muted">${durationText(start, end)}</td>
      <td><span class="status"><span class="bdot"></span>ON → OFF</span></td>`;
    const rmCell = el("td");
    rmCell.style.textAlign = "right";
    const rmBtn = el("button", "iconbtn", "✕");
    rmBtn.disabled = !canMutate();
    rmBtn.title = "Remove this block";
    rmBtn.onclick = () => deleteBlock(block.id);
    rmCell.append(rmBtn);
    tr.append(rmCell);
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
}

async function addBlock() {
  $("#blockError").textContent = "";
  const startDay = Number($("#blockStartDay").value), endDay = Number($("#blockEndDay").value);
  const startTime = $("#schStart").value, endTime = $("#schEnd").value;
  const start = blockMinutes(startDay, startTime), end = blockMinutes(endDay, endTime);
  if (end <= start) {
    $("#blockError").textContent = "The end of the block must be later than its start. Choose a later day/time.";
    return;
  }
  const body = { startDay, startTime, endDay, endTime };
  try {
    if (editing.mode === "bulk") {
      const res = await api("/api/schedules/bulk", { method: "POST", body: { ...body, monitorIds: editing.monitorIds } });
      apply(res.state);
      $("#modal").classList.add("hidden");
      const skipped = res.skipped.length;
      toast(skipped
        ? `Added to ${res.applied} monitor(s), skipped ${skipped} (would overlap)`
        : `Added to ${res.applied} monitor(s)`, skipped ? "err" : "ok");
      loadLogs();
      return;
    }
    const res = await api(`/api/schedules/${editing.monitorId}`, { method: "POST", body });
    apply(res.state);
    resetBlockForm();
    renderBlockTable();
    $("#schDeleteAll").classList.toggle("hidden", currentMonitor(editing.monitorId).blocks.length === 0);
    toast("Time block added");
    loadLogs();
  } catch (err) {
    if (editing.mode === "bulk") toast(err.message, "err");
    else $("#blockError").textContent = err.message;
  }
}

async function deleteBlock(blockId) {
  if (!confirm("Remove this time block?")) return;
  try {
    const res = await api(`/api/schedules/${editing.monitorId}/${blockId}`, { method: "DELETE" });
    apply(res.state);
    renderBlockTable();
    $("#schDeleteAll").classList.toggle("hidden", currentMonitor(editing.monitorId).blocks.length === 0);
    toast("Block removed");
  } catch (err) { toast(err.message, "err"); }
}

// ---------- team ----------
function roleOptionsFor(actorRole) {
  return actorRole === "super-admin" ? ["viewer", "editor", "admin", "super-admin"] : ["viewer", "editor", "admin"];
}

async function loadTeam() {
  if (!canManageTeam()) return;
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
    // createdAt/lastLoginAt come from src/lib/auth.ts's publicUser() as ISO
    // strings (unlike the epoch-seconds timestamps used elsewhere in this
    // app) — Date must be given the string directly, not string*1000.
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—";
    const lastLogin = u.lastLoginAt
      ? new Date(u.lastLoginAt).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "never";
    lead.append(el("div", "meta", `Added ${created} · Last login ${lastLogin}`));
    row.append(lead);

    const roleSelect = el("select", "input");
    roleOptionsFor(session.role).forEach((r) => {
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

function renderInviteRoleOptions() {
  const select = $("#inviteRole");
  const current = select.value;
  select.innerHTML = "";
  // Role text is shown as the raw value (e.g. "super-admin") everywhere in
  // this app — the badge and the per-member role <select> both do this — so
  // match that here instead of title-casing, which was the inconsistency.
  roleOptionsFor(session ? session.role : "admin").forEach((r) => {
    const opt = el("option", null, r);
    opt.value = r;
    select.append(opt);
  });
  if ([...select.options].some((o) => o.value === current)) select.value = current;
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
document.querySelectorAll(".side-btn[data-tab]").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".side-btn[data-tab]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    ["monitors", "logs", "settings", "team"].forEach((name) =>
      $(`#tab-${name}`).classList.toggle("hidden", name !== tab.dataset.tab));
    if (tab.dataset.tab === "logs") loadLogs();
    if (tab.dataset.tab === "settings") loadUsage();
    if (tab.dataset.tab === "team") { renderInviteRoleOptions(); loadTeam(); }
  };
});

$("#folderSearch").oninput = renderFolders;
$("#backToFolders").onclick = backToFolders;
$("#search").oninput = renderMonitors;
$("#scheduledOnly").onchange = renderMonitors;
$("#inactiveOnly").onchange = renderMonitors;
$("#logLevel").onchange = loadLogs;
$("#logSearch").oninput = loadLogs;
$("#schStart").oninput = updateBlockPreview;
$("#schEnd").oninput = updateBlockPreview;
$("#blockStartDay").onchange = updateBlockPreview;
$("#blockEndDay").onchange = updateBlockPreview;
$("#schCancel").onclick = () => $("#modal").classList.add("hidden");
$("#blockSave").onclick = addBlock;
$("#schDeleteAll").onclick = async () => {
  if (!confirm("Remove every time block from this monitor?")) return;
  try {
    const res = await api(`/api/schedules/${editing.monitorId}`, { method: "DELETE" });
    apply(res.state);
    $("#modal").classList.add("hidden");
    toast("Schedule cleared");
  } catch (err) { toast(err.message, "err"); }
};

$("#bulkSchedule").onclick = openBulkEditor;

$("#bulkClearSchedule").onclick = async () => {
  if (!selected.size) return;
  if (!confirm(`Remove all schedule blocks from ${selected.size} monitor(s)?`)) return;
  try {
    const res = await api("/api/schedules/bulk", { method: "DELETE", body: { monitorIds: [...selected] } });
    apply(res.state);
    toast(`Schedules cleared for ${selected.size} monitor(s)`);
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
  const label = button.querySelector("span");
  button.disabled = true; if (label) label.textContent = "Syncing…";
  try {
    const res = await api("/api/sync", { method: "POST" });
    apply(res.state);
    const { projects, monitors, errors } = res.summary;
    toast(`Synced ${projects} project(s), ${monitors} monitor(s)`, errors.length ? "err" : "ok");
  } catch (err) { toast(err.message, "err"); }
  finally { button.disabled = false; if (label) label.textContent = "Sync"; }
};

$("#addByIdBtn").onclick = () => {
  const select = $("#adoptProject");
  select.innerHTML = state.projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  if (activeProjectId && activeProjectId !== "__all__") select.value = activeProjectId;
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
  if (canManageTeam()) { renderInviteRoleOptions(); loadTeam(); }

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
