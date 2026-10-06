let dashboardKey = localStorage.getItem("dashboard_key");
let selectedId = null;
let renderedInThread = 0;

async function ensureKey() {
  while (!dashboardKey) {
    dashboardKey = window.prompt("Dashboard key (set as DASHBOARD_KEY in .env):");
    if (dashboardKey) localStorage.setItem("dashboard_key", dashboardKey);
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-dashboard-key": dashboardKey, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    // Bad/stale key — clear it and ask again on the next action.
    localStorage.removeItem("dashboard_key");
    dashboardKey = null;
    alert("Dashboard key was rejected. Reload the page and enter it again.");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function renderList(conversations) {
  const list = document.getElementById("convList");
  const count = document.getElementById("count");
  count.textContent = conversations.length;
  list.innerHTML = "";

  for (const c of conversations) {
    const el = document.createElement("div");
    el.className = "conv-item" + (c.id === selectedId ? " active" : "");
    el.innerHTML = `
      <span class="badge ${c.status}">${c.status === "human" ? "picked up" : "waiting"}</span>
      <div class="preview">${escapeHtml(c.lastMessage || "(no messages)")}</div>
    `;
    el.addEventListener("click", () => selectConversation(c.id));
    list.appendChild(el);
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderThread(messages) {
  const thread = document.getElementById("thread");
  thread.innerHTML = "";
  for (const m of messages) {
    const el = document.createElement("div");
    const cls = m.role === "tool" ? "tool" : m.role;
    el.className = "msg " + cls;
    el.textContent = m.role === "tool" ? `🔧 ${m.toolName}: ${m.content}` : m.content;
    thread.appendChild(el);
  }
  thread.scrollTop = thread.scrollHeight;
  renderedInThread = messages.length;
}

async function refreshList() {
  try {
    const conversations = await api("/api/dashboard/conversations");
    renderList(conversations);
  } catch {
    /* handled in api() */
  }
}

async function selectConversation(id) {
  selectedId = id;
  document.getElementById("toolbar").style.display = "flex";
  document.getElementById("replyForm").style.display = "flex";
  await loadThread();
  await refreshList(); // re-render list so the "active" highlight moves
}

async function loadThread() {
  if (!selectedId) return;
  try {
    const conversation = await api(`/api/dashboard/conversations/${selectedId}`);
    document.getElementById("convTitle").textContent = `Conversation ${selectedId.slice(0, 8)} — ${conversation.status}`;
    renderThread(conversation.messages);
  } catch {
    /* handled in api() */
  }
}

document.getElementById("pickupBtn").addEventListener("click", async () => {
  if (!selectedId) return;
  await api(`/api/dashboard/conversations/${selectedId}/pickup`, { method: "POST" });
  await loadThread();
  await refreshList();
});

document.getElementById("resolveBtn").addEventListener("click", async () => {
  if (!selectedId) return;
  await api(`/api/dashboard/conversations/${selectedId}/resolve`, { method: "POST" });
  document.getElementById("toolbar").style.display = "none";
  document.getElementById("replyForm").style.display = "none";
  document.getElementById("thread").innerHTML = '<div class="empty">Resolved. Select another conversation.</div>';
  selectedId = null;
  await refreshList();
});

document.getElementById("replyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("replyInput");
  const text = input.value.trim();
  if (!text || !selectedId) return;
  input.value = "";
  await api(`/api/dashboard/conversations/${selectedId}/reply`, {
    method: "POST",
    body: JSON.stringify({ message: text }),
  });
  await loadThread();
});

(async function init() {
  await ensureKey();
  await refreshList();
  setInterval(refreshList, 4000);
  setInterval(() => {
    if (selectedId) loadThread();
  }, 3000);

  setupTabs();
})();

// --- Tabs + appointments -----------------------------------------------

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.page).classList.add("active");
      if (btn.dataset.page === "appointmentsPage") loadAppointments();
    });
  });
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

async function loadAppointments() {
  try {
    const appointments = await api("/api/dashboard/appointments");
    const rows = document.getElementById("apptRows");
    const empty = document.getElementById("apptEmpty");
    rows.innerHTML = "";

    if (appointments.length === 0) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    for (const a of appointments) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatWhen(a.startTime)}</td>
        <td>${escapeHtml(a.service)}</td>
        <td>${escapeHtml(a.customerName)}</td>
        <td>${escapeHtml(a.customerPhone)}</td>
        <td><span class="status-pill ${a.status}">${a.status}</span></td>
      `;
      rows.appendChild(tr);
    }
  } catch {
    /* handled in api() */
  }
}
