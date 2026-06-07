// Renderer script. Fetches the ticket list from the backend and renders it.

const POLL_INTERVAL_MS = 60_000;

// Shape mirrors the backend `/tickets` rows: a provider `Ticket` flattened
// and enriched with its originating project's context.
interface TicketRow {
  id: string;
  title: string;
  status: string;
  url: string;
  labels: string[];
  provider: string;
  project_id: string;
  project_path: string;
  // Optional: backend may return null or omit the field entirely for tickets
  // without a linked PR; both are treated the same (no PR accent).
  pull_request?: {
    number: number;
    url: string;
    status: string;
    draft: boolean;
  } | null;
}

function setStatus(text: string): void {
  const bar = document.querySelector(".status-bar");
  if (bar) bar.textContent = text;
}

function renderTickets(list: HTMLElement, tickets: TicketRow[]): void {
  list.replaceChildren();

  // Pass 1: group tickets by project_id, preserving insertion order.
  const groups = new Map<string, TicketRow[]>();
  for (const ticket of tickets) {
    const key = ticket.project_id ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.push(ticket);
    } else {
      groups.set(key, [ticket]);
    }
  }

  // Pass 2: for each group render a project heading followed by its cards.
  for (const [, groupTickets] of groups) {
    // Project group header: label + per-group count badge.
    const headerLi = document.createElement("li");
    headerLi.className = "project-group-header";

    const headerText = document.createElement("span");
    headerText.className = "group-label";
    headerText.textContent = groupTickets[0].project_path ?? "";

    const countBadge = document.createElement("span");
    countBadge.className = "group-count";
    countBadge.textContent = String(groupTickets.length);

    headerLi.appendChild(headerText);
    headerLi.appendChild(countBadge);
    list.appendChild(headerLi);

    // Ticket cards for this group.
    for (const ticket of groupTickets) {
      const li = document.createElement("li");
      li.className = ticket.pull_request != null
        ? "ticket-card ticket-card--has-pr"
        : "ticket-card";

      // Card head: provider badge + ticket id
      const head = document.createElement("div");
      head.className = "card-head";

      const providerSpan = document.createElement("span");
      providerSpan.className = "card-provider";
      providerSpan.textContent = ticket.provider ?? "";

      const idSpan = document.createElement("span");
      idSpan.className = "card-id";
      idSpan.textContent = ticket.id ? `#${ticket.id}` : "";

      head.appendChild(providerSpan);
      head.appendChild(idSpan);

      // Card title: the ticket's title
      const titleDiv = document.createElement("div");
      titleDiv.className = "card-title";
      titleDiv.textContent = ticket.title ?? "";

      // Card meta: which project the ticket belongs to + its status
      const metaDiv = document.createElement("div");
      metaDiv.className = "card-meta";
      const metaParts = [ticket.project_path, ticket.status].filter(Boolean);
      metaDiv.textContent = metaParts.join(" · ");

      li.appendChild(head);
      li.appendChild(titleDiv);
      li.appendChild(metaDiv);
      list.appendChild(li);
    }
  }
}

async function loadTickets(): Promise<void> {
  const list = document.getElementById("ticket-list");
  if (!list) return;

  // The backend fans out a provider call per project, so the first paint
  // can take a couple of seconds — show progress instead of a blank panel.
  setStatus("Lädt Tickets…");

  let tickets: TicketRow[];
  try {
    const response = await window.backend.fetchJson("/tickets");
    if (!response.ok) {
      throw new Error(`Backend antwortete mit HTTP ${response.status}`);
    }
    tickets = response.data as TicketRow[];
  } catch (err) {
    setStatus(`Fehler beim Laden: ${err instanceof Error ? err.message : String(err)}`);
    const countEl = document.getElementById("ticket-count");
    if (countEl) countEl.textContent = "!";
    return;
  }

  renderTickets(list, tickets);

  const countEl = document.getElementById("ticket-count");
  if (countEl) countEl.textContent = String(tickets.length);

  setStatus(tickets.length === 0 ? "Keine offenen Tickets" : "");
}

// Starts the periodic poll and wires up the backend-crashed listener.
// Exported so tests can drive the real production wiring without re-importing
// the module; the guard block below calls it at app startup.
function initRenderer(): void {
  loadTickets();

  // Poll for the lifetime of the app. The interval is cleared if the backend
  // crashes so the crash message is not overwritten by a subsequent poll.
  const pollId = setInterval(loadTickets, POLL_INTERVAL_MS);

  window.backend.onBackendCrashed((code: number | null) => {
    clearInterval(pollId);
    setStatus(`Backend abgestürzt (Code ${code ?? "?"})`);
  });
}

// Only auto-run when the Electron preload has injected window.backend.
// In test environments (jsdom without a preload) this guard prevents a crash.
if (typeof window !== "undefined" && window.backend) {
  initRenderer();
}

// Expose functions for unit tests via a CommonJS-style guard that is safe in a
// classic <script> context: `typeof module` never throws even when `module` is
// not declared, so in the browser this block is simply skipped at runtime.
// tsc emits this verbatim (no `exports.` preamble) because there are no
// top-level `export` declarations above.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { setStatus, renderTickets, loadTickets, initRenderer, POLL_INTERVAL_MS };
}
