// Renderer script. Fetches the ticket list from the backend and renders it.
async function loadTickets(): Promise<void> {
  const response = await window.backend.fetch("/tickets");
  const tickets: Array<{ id: string; description: string; provider: string; path: string }> =
    await response.json();

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
    idSpan.textContent = ticket.id ?? "";

    head.appendChild(providerSpan);
    head.appendChild(idSpan);

    // Card title: description
    const titleDiv = document.createElement("div");
    titleDiv.className = "card-title";
    titleDiv.textContent = ticket.description ?? "";

    // Card meta: path
    const metaDiv = document.createElement("div");
    metaDiv.className = "card-meta";
    metaDiv.textContent = ticket.path ?? "";

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
