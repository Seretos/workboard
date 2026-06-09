// Renderer script for the ticket detail window.
// Receives ticket data from main via IPC and populates the DOM anchors.

// Ambient globals injected via vendor UMD scripts loaded before detail.js.
declare const marked: { parse: (src: string) => string };
declare const DOMPurify: { sanitize: (html: string) => string };

// Shape of the data pushed from main over "ticket-detail-data".
interface DetailTicket {
  id?: string;
  title?: string;
  body?: string;
  url?: string;
  status?: string;
  pull_request?: {
    url: string;
    status: string;
  } | null;
}

function render(ticket: unknown): void {
  const t = ticket as DetailTicket;

  const titleEl = document.getElementById("detail-title");
  if (titleEl) titleEl.textContent = t.title ?? "";

  const idEl = document.getElementById("detail-id");
  if (idEl) idEl.textContent = t.id ?? "";

  const statusPill = document.getElementById("detail-status-pill");
  if (statusPill) statusPill.textContent = t.status ?? "";

  // Render Markdown body via marked + DOMPurify.
  const bodyEl = document.getElementById("detail-body-md");
  if (bodyEl) {
    const raw = marked.parse(t.body ?? "");
    bodyEl.innerHTML = DOMPurify.sanitize(raw) as string;
  }

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

  // Wire the footer "In Browser öffnen" button.
  const ghBtn = document.getElementById("detail-gh-btn") as HTMLButtonElement | null;
  if (ghBtn) {
    ghBtn.onclick = () => {
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
  // Attach link-delegation listener ONCE on the body container so clicks on
  // any <a> descendants open externally and do not navigate the window.
  // Only forward http(s) URLs — a relative Markdown link (e.g. [docs](CONTRIBUTING.md))
  // resolves to a file:// path in the packaged app, which would ask the OS to open
  // a local bundle file. We preventDefault in all cases so the window never navigates.
  const bodyContainer = document.getElementById("detail-body-md");
  if (bodyContainer) {
    bodyContainer.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (anchor && anchor.href) {
        e.preventDefault();
        if (anchor.href.startsWith("http://") || anchor.href.startsWith("https://")) {
          window.detail.openExternal(anchor.href);
        }
        // Non-http(s) links (file://, relative, etc.) are silently swallowed.
      }
    });
  }

  // Close buttons call window.close(); the main process close handler hides
  // the window rather than destroying it (isQuitting guard in main.ts).
  const closeBtn = document.getElementById("detail-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => window.close());
  }
  const closeFooter = document.getElementById("detail-close-footer");
  if (closeFooter) {
    closeFooter.addEventListener("click", () => window.close());
  }

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
