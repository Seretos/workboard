// Renderer script. Fetches the ticket list from the backend and renders it.

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
}

async function loadTickets(): Promise<void> {
  const response = await window.backend.fetch("/tickets");
  const tickets: TicketRow[] = await response.json();

  const list = document.getElementById("ticket-list");
  if (!list) return;

  for (const ticket of tickets) {
    const li = document.createElement("li");
    li.className = "ticket-card";

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

  // Update ticket count badge
  const countEl = document.getElementById("ticket-count");
  if (countEl) {
    countEl.textContent = String(tickets.length);
  }
}

loadTickets();
