// Renderer script. Fetches the ticket list from the backend and renders it.
async function loadTickets(): Promise<void> {
  const response = await window.backend.fetch("/tickets");
  const tickets: Array<{ id: string; description: string; provider: string; path: string }> =
    await response.json();

  const list = document.getElementById("ticket-list");
  if (!list) return;

  for (const ticket of tickets) {
    const li = document.createElement("li");
    li.textContent = `[${ticket.provider}] ${ticket.id}: ${ticket.description} (${ticket.path})`;
    list.appendChild(li);
  }
}

loadTickets();
