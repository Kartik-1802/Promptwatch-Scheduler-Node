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
let activeProjectId = null; // null = project list (homepage), or the open project's id
let editing = null; // { projectId } while the schedule modal is open
let editingBlockId = null; // id of the block currently loaded into the form, or null when adding new
const selectedMonitors = new Set(); // monitors selected inside an open project
const selectedProjects = new Set(); // projects selected on the Projects homepage
const selectedAllMonitors = new Set(); // monitors selected on the flat "Monitors" tab

const MUTATE_ROLES = new Set(["editor", "admin", "super-admin"]);
const SETTINGS_ROLES = new Set(["admin", "super-admin"]);
const TEAM_ROLES = new Set(["admin", "super-admin"]);
const canMutate = () => session && MUTATE_ROLES.has(session.role);
const canSettings = () => session && SETTINGS_ROLES.has(session.role);
const canManageTeam = () => session && TEAM_ROLES.has(session.role);

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

function showLoading(text = "Loading…") {
  $("#loadingText").textContent = text;
  $("#loadingOverlay").classList.remove("hidden");
}
function hideLoading() {
  $("#loadingOverlay").classList.add("hidden");
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
  const suffix = block.trigger === "off_on" ? " (OFF→ON)" : "";
  return `${DAYS[block.startDay]} ${block.startTime} → ${DAYS[block.endDay]} ${block.endTime}${suffix}`;
}

function monitorsInScope(projectId) {
  if (!state) return [];
  if (!projectId) return state.monitors;
  return state.monitors.filter((m) => m.projectId === projectId);
}

function currentProject() {
  return activeProjectId ? state.projects.find((p) => p.id === activeProjectId) || null : null;
}

/** Projects with zero monitors have nothing to schedule or manage — mostly
 * empty duplicates from Promptwatch's side — so they're left out of the
 * projects list and its counts. They're still selectable from "Add by ID"
 * (that's the one place you'd want an otherwise-empty project), since that
 * reads from state.projects directly rather than this filtered view. */
function manageableProjects() {
  return state.projects.filter((p) => p.monitorCount > 0);
}

/** Icon helper — inline SVG rather than emoji, per the UI/UX rules. */
function icon(path, cls = "ico") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}
const ICON_CHEVRON = "M9.4 18.4 8 17l5-5-5-5 1.4-1.4L15.8 12z";
const ICON_CLOCK = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 10.6V6h-2v7.4l5 3 1-1.7-4-2.1Z";
const ICON_TRASH = "M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 12H7L6 9Z";

function renderStats() {
  const project = currentProject();
  const monitors = monitorsInScope(activeProjectId);
  const activeCount = monitors.filter((m) => m.active).length;

  const primary = $("#statPrimary");
  primary.innerHTML = "";
  primary.append(el("b", null, `${activeCount}/${monitors.length}`), el("span", null, "monitors on"));

  const secondary = $("#statSecondary");
  secondary.innerHTML = "";
  const chips = project
    ? [
        [project.blocks.length, project.blocks.length === 1 ? "time block" : "time blocks"],
        [project.desiredActive === null ? "Manual" : (project.inWindow ? "In window" : "Outside window"), "right now"],
      ]
    : [
        [manageableProjects().filter((p) => p.blocks.length > 0).length, "projects scheduled"],
        [manageableProjects().length, "projects"],
      ];
  chips.forEach(([value, label]) => {
    const chip = el("div", "stat-chip");
    chip.append(el("b", null, String(value)), el("span", null, label));
    secondary.append(chip);
  });
}

// ---------- schedule summary (shared by project rows + project header) ----------
function scheduleSummary(project, { compact = false } = {}) {
  const wrap = el("div", "sched");
  if (!project.blocks.length) {
    wrap.append(el("div", "sched-none", "No schedule — monitors run manually"));
    return wrap;
  }
  const shown = compact ? project.blocks.slice(0, 3) : project.blocks;
  shown.forEach((b) => wrap.append(el("span", "block-chip", describeBlock(b))));
  if (compact && project.blocks.length > 3) {
    wrap.append(el("span", "block-chip more", `+${project.blocks.length - 3} more`));
  }
  if (project.nextTransition) {
    const when = new Date(project.nextTransition.at);
    wrap.append(el("div", "sched-next",
      `Next: turns ${project.nextTransition.to === "active" ? "ON" : "OFF"} ${when.toLocaleString([], {
        weekday: "short", hour: "2-digit", minute: "2-digit" })}`));
  }
  return wrap;
}

function scheduleStateBadge(project) {
  if (project.desiredActive === null) return el("span", "badge", "Manual");
  return el("span", `badge ${project.inWindow ? "on" : "off"}`, project.inWindow ? "In window" : "Outside window");
}

// ---------- projects view (homepage) ----------
function renderProjects() {
  const list = $("#projectList");
  const term = $("#projectSearch").value.trim().toLowerCase();
  list.innerHTML = "";

  const visible = manageableProjects().filter((p) => !term || p.name.toLowerCase().includes(term));
  $("#emptyProjects").classList.toggle("hidden", manageableProjects().length > 0);

  const liveIds = new Set(visible.map((p) => p.id));
  [...selectedProjects].forEach((id) => { if (!liveIds.has(id)) selectedProjects.delete(id); });
  renderProjectSelectBar(visible);

  visible.forEach((p) => {
    const row = el("div", `prow${selectedProjects.has(p.id) ? " sel" : ""}`);

    const check = el("input");
    check.type = "checkbox";
    check.className = "rowcheck";
    check.checked = selectedProjects.has(p.id);
    check.setAttribute("aria-label", `Select ${p.name}`);
    check.onchange = () => {
      check.checked ? selectedProjects.add(p.id) : selectedProjects.delete(p.id);
      renderProjects();
    };
    row.append(check);

    const open = el("button", "prow-open");
    open.setAttribute("aria-label", `Open ${p.name}`);
    const lead = el("span", "lead");
    lead.append(el("span", "pname", p.name));
    const bits = [`${p.monitorCount} monitor${p.monitorCount === 1 ? "" : "s"}`, `${p.activeCount} on`];
    if (p.website) bits.push(p.website.replace(/^https?:\/\//, ""));
    lead.append(el("span", "meta", bits.join(" · ")));
    open.append(lead);
    open.append(icon(ICON_CHEVRON, "ico chev"));
    open.onclick = () => openProject(p.id);
    row.append(open);

    const mid = el("div", "prow-sched");
    mid.append(scheduleStateBadge(p));
    mid.append(scheduleSummary(p, { compact: true }));
    row.append(mid);

    const actions = el("div", "prow-actions");
    const sched = el("button", "btn primary", p.blocks.length ? "Edit schedule" : "Add schedule");
    sched.disabled = !canMutate();
    sched.onclick = () => openEditor(p);
    actions.append(sched);
    row.append(actions);

    list.append(row);
  });
}

function renderProjectSelectBar(visibleRows) {
  const visibleIds = visibleRows.map((p) => p.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedProjects.has(id));
  const selectAll = $("#selectAllProjects");
  selectAll.checked = allVisibleSelected;
  selectAll.disabled = !visibleIds.length;
  selectAll.onchange = () => {
    if (selectAll.checked) visibleIds.forEach((id) => selectedProjects.add(id));
    else visibleIds.forEach((id) => selectedProjects.delete(id));
    renderProjects();
  };
  $("#selectAllProjectsLabel").textContent = selectedProjects.size ? "Select all" : `Select all (${visibleIds.length})`;
  $("#projectBulkActions").classList.toggle("hidden", selectedProjects.size === 0);
  $("#selectedProjectCount").textContent = `${selectedProjects.size} selected`;
}

function openProject(id) {
  activeProjectId = id;
  selectedMonitors.clear();
  $("#crumbs").classList.remove("hidden");
  $("#projectsView").classList.add("hidden");
  $("#projectView").classList.remove("hidden");
  const project = state.projects.find((p) => p.id === id);
  const name = project ? project.name : "Project";
  $("#projectViewTitle").textContent = name;
  $("#pageTitle").textContent = name;
  $("#pageSub").textContent = "This project's schedule drives every monitor below.";
  renderStats();
  renderProjectScheduleBar();
  renderMonitors();
}

function backToProjects() {
  activeProjectId = null;
  selectedMonitors.clear();
  $("#crumbs").classList.add("hidden");
  $("#projectView").classList.add("hidden");
  $("#projectsView").classList.remove("hidden");
  $("#pageTitle").textContent = "Projects";
  $("#pageSub").textContent = "Every project and its schedule. Open one to see its monitors.";
  renderStats();
  renderProjects();
}

/** The project's schedule, shown inside the project — scheduling is only ever
 * done here at project level, never per monitor. */
function renderProjectScheduleBar() {
  const project = currentProject();
  const bar = $("#projectScheduleBar");
  bar.innerHTML = "";
  if (!project) return;

  const left = el("div", "psb-left");
  const head = el("div", "psb-head");
  head.append(icon(ICON_CLOCK, "ico"));
  head.append(el("span", null, "Project schedule"));
  head.append(scheduleStateBadge(project));
  left.append(head);
  left.append(scheduleSummary(project));
  bar.append(left);

  const btn = el("button", "btn primary", project.blocks.length ? "Edit schedule" : "Add schedule");
  btn.disabled = !canMutate();
  btn.onclick = () => openEditor(project);
  bar.append(btn);
}

// ---------- monitors (inside a project) ----------
function renderMonitors() {
  if (activeProjectId === null) return; // project list is shown instead
  const list = $("#monitorList");
  const term = $("#search").value.trim().toLowerCase();
  const onlyInactive = $("#inactiveOnly").checked;

  const scope = monitorsInScope(activeProjectId);
  const liveIds = new Set(scope.map((m) => m.id));
  [...selectedMonitors].forEach((id) => { if (!liveIds.has(id)) selectedMonitors.delete(id); });

  const rows = scope.filter((m) => {
    if (onlyInactive && m.active) return false;
    if (!term) return true;
    return m.name.toLowerCase().includes(term);
  });

  list.innerHTML = "";
  $("#emptyMonitors").classList.toggle("hidden", rows.length > 0);
  renderSelectBar(rows);
  rows.forEach((m) => list.append(monitorRow(m, selectedMonitors, renderMonitors)));
}

function renderSelectBar(visibleRows) {
  const visibleIds = visibleRows.map((m) => m.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedMonitors.has(id));
  const selectAll = $("#selectAll");
  selectAll.checked = allVisibleSelected;
  selectAll.disabled = !visibleIds.length;
  selectAll.onchange = () => {
    if (selectAll.checked) visibleIds.forEach((id) => selectedMonitors.add(id));
    else visibleIds.forEach((id) => selectedMonitors.delete(id));
    renderMonitors();
  };
  $("#selectAllLabel").textContent = selectedMonitors.size ? "Select all" : `Select all (${visibleIds.length})`;
  $("#bulkActions").classList.toggle("hidden", selectedMonitors.size === 0);
  $("#selectedCount").textContent = `${selectedMonitors.size} selected`;
}

// ---------- all monitors (flat, across every project) ----------
// View/activate only — scheduling always happens on the Projects tab.
function monitorRow(m, selectedSet, onToggleRerender) {
  const row = el("div", `mrow${selectedSet.has(m.id) ? " sel" : ""}`);

  const check = el("input");
  check.type = "checkbox";
  check.className = "rowcheck";
  check.checked = selectedSet.has(m.id);
  check.setAttribute("aria-label", `Select ${m.name}`);
  check.onchange = () => {
    check.checked ? selectedSet.add(m.id) : selectedSet.delete(m.id);
    onToggleRerender();
  };
  row.append(check);

  const lead = el("div", "lead");
  const name = el("div", "mname");
  name.append(el("span", null, m.name));
  if (m.staleSince) name.append(el("span", "badge warnb", "Sync issue"));
  lead.append(name);
  const bits = [m.projectName, `${m.promptCount ?? 0} prompts`, `${(m.models || []).length} models`];
  if (m.countryCode) bits.push(`${m.countryCode}/${m.languageCode || "—"}`);
  lead.append(el("div", "meta", bits.join(" · ")));
  row.append(lead);

  const toggleWrap = el("div", "toggle-wrap");
  const stateLabel = el("span", `toggle-state ${m.active ? "on" : "off"}`, m.active ? "ON" : "OFF");
  const toggle = el("button", `toggle${m.active ? " on" : ""}`);
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(m.active));
  toggle.setAttribute("aria-label", `${m.name} is ${m.active ? "on" : "off"}`);
  toggle.append(el("span", "knob"));
  toggle.disabled = !canMutate();
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      const res = await api(`/api/monitors/${m.id}/active`, { method: "POST", body: { active: !m.active } });
      apply(res.state);
      toast(`${m.name} is now ${!m.active ? "ON" : "OFF"}`);
    } catch (err) { toast(err.message, "err"); }
    finally { toggle.disabled = !canMutate(); }
  };
  toggleWrap.append(stateLabel, toggle);
  row.append(toggleWrap);

  return row;
}

function renderAllMonitors() {
  const term = $("#allMonSearch").value.trim().toLowerCase();
  const onlyInactive = $("#allMonInactiveOnly").checked;

  const liveIds = new Set(state.monitors.map((m) => m.id));
  [...selectedAllMonitors].forEach((id) => { if (!liveIds.has(id)) selectedAllMonitors.delete(id); });

  const rows = state.monitors.filter((m) => {
    if (onlyInactive && m.active) return false;
    if (!term) return true;
    return `${m.name} ${m.projectName}`.toLowerCase().includes(term);
  });

  const primary = $("#allMonStatPrimary");
  primary.innerHTML = "";
  primary.append(el("b", null, `${state.monitors.filter((m) => m.active).length}/${state.monitors.length}`), el("span", null, "monitors on"));

  const list = $("#allMonitorList");
  list.innerHTML = "";
  $("#allMonEmpty").classList.toggle("hidden", rows.length > 0);
  renderAllMonSelectBar(rows);
  rows.forEach((m) => list.append(monitorRow(m, selectedAllMonitors, renderAllMonitors)));
}

function renderAllMonSelectBar(visibleRows) {
  const visibleIds = visibleRows.map((m) => m.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedAllMonitors.has(id));
  const selectAll = $("#allMonSelectAll");
  selectAll.checked = allVisibleSelected;
  selectAll.disabled = !visibleIds.length;
  selectAll.onchange = () => {
    if (selectAll.checked) visibleIds.forEach((id) => selectedAllMonitors.add(id));
    else visibleIds.forEach((id) => selectedAllMonitors.delete(id));
    renderAllMonitors();
  };
  $("#allMonSelectAllLabel").textContent = selectedAllMonitors.size ? "Select all" : `Select all (${visibleIds.length})`;
  $("#allMonBulkActions").classList.toggle("hidden", selectedAllMonitors.size === 0);
  $("#allMonSelectedCount").textContent = `${selectedAllMonitors.size} selected`;
}

async function allMonBulkSetActive(active) {
  if (!selectedAllMonitors.size) return;
  try {
    const res = await api("/api/monitors/active-bulk", { method: "POST",
      body: { monitorIds: [...selectedAllMonitors], active } });
    apply(res.state);
    const failedCount = res.failed.length;
    toast(failedCount
      ? `${res.changed.length} updated, ${failedCount} failed`
      : `${res.changed.length} monitor(s) ${active ? "turned on" : "turned off"}`,
      failedCount ? "err" : "ok");
  } catch (err) { toast(err.message, "err"); }
}

function renderTop() {
  const on = state.settings.schedulerEnabled && state.settings.hasApiKey;
  const label = on
    ? `Automation on · last check ${fmtTime(state.lastTickAt)}`
    : (state.settings.hasApiKey ? "Automation paused" : "No API key");
  $("#tickLabel").textContent = label;
  $("#tickState .dot").classList.toggle("off", !on);
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
  if (activeProjectId === null) {
    renderProjects();
  } else {
    renderProjectScheduleBar();
    renderMonitors();
  }
  if (!$("#tab-allmonitors").classList.contains("hidden")) renderAllMonitors();
  renderStats();
  renderSettings();
  applyRoleUI();
}

const MUTATE_BUTTON_IDS = ["syncBtn", "runNow", "addByIdBtn", "adoptSave",
  "bulkActivate", "bulkDeactivate", "allMonBulkActivate", "allMonBulkDeactivate",
  "projectBulkActivate", "projectBulkDeactivate", "projectBulkSchedule", "projectBulkClearSchedule"];
const SETTINGS_INPUT_IDS = ["apiKey", "saveKey", "testKey", "clearKey",
  "timezone", "tickSeconds", "schedulerEnabled", "saveScheduler"];

function applyRoleUI() {
  MUTATE_BUTTON_IDS.forEach((id) => { const e = $(`#${id}`); if (e) e.disabled = !canMutate(); });
  SETTINGS_INPUT_IDS.forEach((id) => { const e = $(`#${id}`); if (e) e.disabled = !canSettings(); });
  $("#teamTabBtn").classList.toggle("hidden", !canManageTeam());
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

// ---------- schedule editor (a PROJECT's time blocks) ----------
// Structure/logic ported from the time-block-scheduler reference: a block is
// a single (startDay,startTime) -> (endDay,endTime) range, not a set of
// repeated weekdays. Days are 0=Mon..6=Sun to match this app's convention
// (the reference used 1-7); everything else — minute math, the "end must be
// later than start" rule, the live preview, the blocks table — mirrors it.
// Schedules are always project-level; monitors have no schedule of their own.
function editingProject() {
  return state.projects.find((p) => p.id === editing.projectId) || null;
}

const WEEK_MINUTES = 7 * 1440;

function blockMinutes(day, time) {
  const [h, m] = time.split(":").map(Number);
  return day * 1440 + h * 60 + m;
}

/** end <= start means the block wraps past Sunday into next Monday, not
 * that it's zero-length — add a week back to get the real duration. */
function blockDuration(startMin, endMin) {
  return endMin > startMin ? endMin - startMin : WEEK_MINUTES - startMin + endMin;
}

function durationText(minutes) {
  const daysCount = Math.floor(minutes / 1440);
  minutes %= 1440;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
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
  editingBlockId = null;
  populateBlockDaySelects();
  $("#schStart").value = "09:00";
  $("#schEnd").value = "17:00";
  $("#blockTrigger").value = "on_off";
  $("#blockError").textContent = "";
  $("#blockPreview").classList.add("hidden");
  $("#blockFormLabel").textContent = "New time block";
  $("#blockSave").textContent = "Add block";
  $("#blockEditCancel").classList.add("hidden");
}

/** Load an existing block into the form so it can be changed in place,
 * instead of only ever being deletable. */
function startEditBlock(block) {
  editingBlockId = block.id;
  $("#blockStartDay").value = String(block.startDay);
  $("#blockEndDay").value = String(block.endDay);
  $("#schStart").value = block.startTime;
  $("#schEnd").value = block.endTime;
  $("#blockTrigger").value = block.trigger;
  $("#blockError").textContent = "";
  $("#blockFormLabel").textContent = "Edit time block";
  $("#blockSave").textContent = "Save changes";
  $("#blockEditCancel").classList.remove("hidden");
  updateBlockPreview();
  $(".block-form").scrollIntoView({ block: "nearest" });
}

function updateBlockPreview() {
  $("#blockError").textContent = "";
  const startDay = Number($("#blockStartDay").value), endDay = Number($("#blockEndDay").value);
  const startTime = $("#schStart").value, endTime = $("#schEnd").value;
  if (!startTime || !endTime) return;
  const start = blockMinutes(startDay, startTime), end = blockMinutes(endDay, endTime);
  const preview = $("#blockPreview");
  if (start === end) {
    preview.classList.add("hidden");
    return;
  }
  const wraps = end <= start;
  const trigger = $("#blockTrigger").value;
  const openState = trigger === "off_on" ? "OFF" : "ON";
  const closeState = trigger === "off_on" ? "ON" : "OFF";
  preview.innerHTML = `<b>Block:</b> ${DAYS[startDay]} ${startTime} → ${DAYS[endDay]} ${endTime}${wraps ? " (wraps into next week)" : ""}
    &nbsp;·&nbsp; Duration: <b>${durationText(blockDuration(start, end))}</b>
    &nbsp;·&nbsp; Start = <b>${openState}</b>, End = <b>${closeState}</b>`;
  preview.classList.remove("hidden");
}

function openEditor(project) {
  editing = { mode: "single", projectId: project.id };
  $("#modalTitle").textContent = `${project.name} — schedule`;
  $("#modalSub").textContent =
    `Applies to all ${project.monitorCount} monitor${project.monitorCount === 1 ? "" : "s"} in this project. ` +
    "Blocks can't overlap or touch each other.";
  $("#blockTableSection").classList.remove("hidden");
  $("#schDeleteAll").classList.toggle("hidden", project.blocks.length === 0);
  resetBlockForm();
  renderBlockTable();
  $("#modal").classList.remove("hidden");
}

function openBulkEditor() {
  if (!selectedProjects.size) return toast("Select at least one project first", "err");
  const ids = [...selectedProjects];
  editing = { mode: "bulk", projectIds: ids };
  $("#modalTitle").textContent = `${ids.length} projects selected`;
  $("#modalSub").textContent = "Adds one new time block to each — any project where it would overlap an existing block is skipped.";
  $("#blockTableSection").classList.add("hidden");
  $("#schDeleteAll").classList.add("hidden");
  resetBlockForm();
  $("#modal").classList.remove("hidden");
}

function renderBlockTable() {
  const project = editingProject();
  if (!project) return;
  const blocks = [...project.blocks].sort((a, b) => blockMinutes(a.startDay, a.startTime) - blockMinutes(b.startDay, b.startTime));
  $("#blockCount").textContent = `${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
  const wrap = $("#blockTableWrap");
  if (!blocks.length) {
    wrap.innerHTML = '<div class="block-empty">No time blocks yet — this project\'s monitors run manually.</div>';
    return;
  }
  wrap.innerHTML = "";
  const table = el("table", "block-table");
  table.innerHTML = `<thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Triggers</th><th></th></tr></thead>`;
  const tbody = el("tbody");
  blocks.forEach((block) => {
    const start = blockMinutes(block.startDay, block.startTime), end = blockMinutes(block.endDay, block.endTime);
    const inverted = block.trigger === "off_on";
    const tr = el("tr", block.id === editingBlockId ? "editing" : "");
    tr.title = "Click to edit this block";
    tr.innerHTML = `
      <td><b>${DAYS[block.startDay]}</b><br><span class="btime">${block.startTime}</span></td>
      <td><b>${DAYS[block.endDay]}</b><br><span class="btime">${block.endTime}</span></td>
      <td class="muted">${durationText(blockDuration(start, end))}</td>
      <td><span class="status${inverted ? " inverted" : ""}"><span class="bdot"></span>${inverted ? "OFF → ON" : "ON → OFF"}</span></td>`;
    tr.onclick = () => startEditBlock(block);
    const rmCell = el("td");
    rmCell.style.textAlign = "right";
    const rmBtn = el("button", "iconbtn");
    rmBtn.append(icon(ICON_TRASH, "ico"));
    rmBtn.disabled = !canMutate();
    rmBtn.title = "Remove this block";
    rmBtn.setAttribute("aria-label", `Remove block ${describeBlock(block)}`);
    rmBtn.onclick = (e) => { e.stopPropagation(); deleteBlock(block.id); };
    rmCell.append(rmBtn);
    tr.append(rmCell);
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
}

async function saveBlock() {
  $("#blockError").textContent = "";
  const startDay = Number($("#blockStartDay").value), endDay = Number($("#blockEndDay").value);
  const startTime = $("#schStart").value, endTime = $("#schEnd").value;
  const trigger = $("#blockTrigger").value;
  if (startDay === endDay && startTime === endTime) {
    $("#blockError").textContent = "Start and end can't be the same moment — pick a different end.";
    return;
  }
  const body = { startDay, startTime, endDay, endTime, trigger };
  try {
    if (editing.mode === "bulk") {
      const res = await api("/api/schedules/bulk", { method: "POST", body: { ...body, projectIds: editing.projectIds } });
      apply(res.state);
      $("#modal").classList.add("hidden");
      const skipped = res.skipped.length;
      toast(skipped
        ? `Added to ${res.applied} project(s), skipped ${skipped} (would overlap)`
        : `Added to ${res.applied} project(s)`, skipped ? "err" : "ok");
      loadLogs();
      return;
    }
    const wasEditing = editingBlockId;
    const endpoint = wasEditing
      ? `/api/schedules/${editing.projectId}/${wasEditing}`
      : `/api/schedules/${editing.projectId}`;
    const res = await api(endpoint, { method: wasEditing ? "PUT" : "POST", body });
    apply(res.state);
    resetBlockForm();
    renderBlockTable();
    $("#schDeleteAll").classList.toggle("hidden", editingProject().blocks.length === 0);
    toast(wasEditing ? "Time block updated" : "Time block added");
    loadLogs();
  } catch (err) {
    $("#blockError").textContent = err.message;
  }
}

async function deleteBlock(blockId) {
  if (!confirm("Remove this time block?")) return;
  try {
    const res = await api(`/api/schedules/${editing.projectId}/${blockId}`, { method: "DELETE" });
    apply(res.state);
    if (blockId === editingBlockId) resetBlockForm();
    renderBlockTable();
    $("#schDeleteAll").classList.toggle("hidden", editingProject().blocks.length === 0);
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
    ["monitors", "allmonitors", "logs", "settings", "team"].forEach((name) =>
      $(`#tab-${name}`).classList.toggle("hidden", name !== tab.dataset.tab));
    if (tab.dataset.tab === "allmonitors") renderAllMonitors();
    if (tab.dataset.tab === "logs") loadLogs();
    if (tab.dataset.tab === "settings") loadUsage();
    if (tab.dataset.tab === "team") { renderInviteRoleOptions(); loadTeam(); }
  };
});

$("#projectSearch").oninput = renderProjects;
$("#backToProjects").onclick = backToProjects;
$("#search").oninput = renderMonitors;
$("#allMonSearch").oninput = renderAllMonitors;
$("#allMonInactiveOnly").onchange = renderAllMonitors;
$("#allMonBulkActivate").onclick = () => allMonBulkSetActive(true);
$("#allMonBulkDeactivate").onclick = () => allMonBulkSetActive(false);
$("#inactiveOnly").onchange = renderMonitors;
$("#logLevel").onchange = loadLogs;
$("#logSearch").oninput = loadLogs;
$("#schStart").oninput = updateBlockPreview;
$("#schEnd").oninput = updateBlockPreview;
$("#blockStartDay").onchange = updateBlockPreview;
$("#blockEndDay").onchange = updateBlockPreview;
$("#blockTrigger").onchange = updateBlockPreview;
$("#schCancel").onclick = () => $("#modal").classList.add("hidden");
$("#blockSave").onclick = saveBlock;
$("#blockEditCancel").onclick = () => { resetBlockForm(); renderBlockTable(); };
$("#schDeleteAll").onclick = async () => {
  const project = editingProject();
  if (!confirm(`Remove every time block from '${project.name}'? Its monitors go back to manual.`)) return;
  try {
    const res = await api(`/api/schedules/${editing.projectId}`, { method: "DELETE" });
    apply(res.state);
    $("#modal").classList.add("hidden");
    toast("Schedule cleared");
    loadLogs();
  } catch (err) { toast(err.message, "err"); }
};

async function bulkSetActive(active) {
  if (!selectedMonitors.size) return;
  try {
    const res = await api("/api/monitors/active-bulk", { method: "POST",
      body: { monitorIds: [...selectedMonitors], active } });
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

// ---------- project-level bulk actions (Projects tab) ----------
async function projectBulkSetActive(active) {
  if (!selectedProjects.size) return;
  const monitorIds = state.monitors.filter((m) => selectedProjects.has(m.projectId)).map((m) => m.id);
  if (!monitorIds.length) return toast("Selected project(s) have no monitors", "err");
  try {
    const res = await api("/api/monitors/active-bulk", { method: "POST", body: { monitorIds, active } });
    apply(res.state);
    const failedCount = res.failed.length;
    toast(failedCount
      ? `${res.changed.length} updated, ${failedCount} failed`
      : `${res.changed.length} monitor(s) ${active ? "turned on" : "turned off"}`,
      failedCount ? "err" : "ok");
  } catch (err) { toast(err.message, "err"); }
}
$("#projectBulkActivate").onclick = () => projectBulkSetActive(true);
$("#projectBulkDeactivate").onclick = () => projectBulkSetActive(false);
$("#projectBulkSchedule").onclick = openBulkEditor;
$("#projectBulkClearSchedule").onclick = async () => {
  if (!selectedProjects.size) return;
  if (!confirm(`Remove all schedule blocks from ${selectedProjects.size} project(s)? Their monitors go back to manual.`)) return;
  try {
    const res = await api("/api/schedules/bulk", { method: "DELETE", body: { projectIds: [...selectedProjects] } });
    apply(res.state);
    toast(`Schedules cleared for ${selectedProjects.size} project(s)`);
    loadLogs();
  } catch (err) { toast(err.message, "err"); }
};

$("#syncBtn").onclick = async () => {
  const button = $("#syncBtn");
  const label = button.querySelector("span");
  button.disabled = true; if (label) label.textContent = "Syncing…";
  showLoading("Syncing with Promptwatch…");
  try {
    const res = await api("/api/sync", { method: "POST" });
    apply(res.state);
    const { projects, monitors, errors } = res.summary;
    toast(`Synced ${projects} project(s), ${monitors} monitor(s)`, errors.length ? "err" : "ok");
  } catch (err) { toast(err.message, "err"); }
  finally { button.disabled = false; if (label) label.textContent = "Sync"; hideLoading(); }
};

$("#addByIdBtn").onclick = () => {
  const select = $("#adoptProject");
  select.innerHTML = state.projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  if (activeProjectId) select.value = activeProjectId;
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
