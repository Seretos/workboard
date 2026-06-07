// Renderer script for the ticket detail window.
// Receives ticket data from main via IPC and populates the DOM anchors.

// Shape of the data pushed from main over "ticket-detail-data".
interface DetailTicket {
  title?: string;
  body?: string;
  url?: string;
  pull_request?: {
    url: string;
    status: string;
  } | null;
}

function render(ticket: unknown): void {
  const t = ticket as DetailTicket;

  const titleEl = document.getElementById("detail-title");
  if (titleEl) titleEl.textContent = t.title ?? "";

  const bodyEl = document.getElementById("detail-body");
  if (bodyEl) bodyEl.textContent = t.body ?? "";

  const ghLink = document.getElementById("detail-gh-link") as HTMLAnchorElement | null;
  if (ghLink) {
    // Never set href to a real URL — always open via shell.openExternal in main
    // so the renderer process cannot navigate away or spawn untrusted content.
    ghLink.onclick = (e) => {
      e.preventDefault();
      if (t.url) {
        window.detail.openExternal(t.url);
      }
    };
  }

  const prSection = document.getElementById("detail-pr-section");
  if (prSection) {
    if (t.pull_request != null) {
      prSection.style.display = "";

      const prLink = document.getElementById("detail-pr-link") as HTMLAnchorElement | null;
      if (prLink) {
        prLink.onclick = (e) => {
          e.preventDefault();
          if (t.pull_request?.url) {
            window.detail.openExternal(t.pull_request.url);
          }
        };
      }

      const prStatus = document.getElementById("detail-pr-status");
      if (prStatus) prStatus.textContent = t.pull_request.status ?? "";
    } else {
      prSection.style.display = "none";
    }
  }
}

function initDetail(): void {
  window.detail.onTicketDetailData((ticket) => {
    render(ticket);
  });
}

// Only auto-run when the Electron preload has injected window.detail.
// In test environments (jsdom without a preload) this guard prevents a crash.
if (typeof window !== "undefined" && (window as Window & typeof globalThis).detail) {
  initDetail();
}

// Expose functions for unit tests via the same CommonJS-style guard as
// renderer.ts — safe in a classic <script> context, skipped in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { render, initDetail };
}
