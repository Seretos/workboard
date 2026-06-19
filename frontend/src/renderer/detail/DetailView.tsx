import React, { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { DetailTicket } from "../types";

// Sanitize HTML safely, handling the case where DOMPurify's internal document
// may not be available (e.g. when jsdom sets up window after module evaluation).
function sanitizeHtml(html: string): string {
  try {
    // DOMPurify.sanitize returns string when called synchronously in a browser/jsdom context.
    const result = DOMPurify.sanitize(html);
    return typeof result === "string" ? result : String(result);
  } catch {
    // Fallback: strip all tags if DOMPurify fails.
    return html.replace(/<[^>]*>/g, "");
  }
}

interface Props {
  ticket: DetailTicket | null;
  /** Called when the "Schließen" footer button is clicked.
   *  Falls back to window.close() when absent (Electron detail window). */
  onClose?: () => void;
  /** Called to open an external URL.
   *  Falls back to window.open in browser mode when absent. */
  openExternal?: (url: string) => void;
}

export function DetailView({ ticket, onClose, openExternal }: Props): React.ReactElement | null {
  if (!ticket) return null;

  const t = ticket;

  // Resolve the openExternal implementation: prop → Electron bridge → browser fallback.
  const resolvedOpenExternal = openExternal
    ?? ((url: string) => {
      const win = window as Window & typeof globalThis;
      if (win.detail?.openExternal) {
        win.detail.openExternal(url);
      } else {
        window.open(url, "_blank", "noopener");
      }
    });

  // Render Markdown body to sanitized HTML string.
  const rawHtml = marked.parse(t.body ?? "") as string;
  const sanitized = sanitizeHtml(rawHtml);

  const bodyContainerRef = useRef<HTMLDivElement | null>(null);

  // Wire link delegation ONCE per mount using an event listener on the body container.
  useEffect(() => {
    const bodyContainer = bodyContainerRef.current;
    if (!bodyContainer) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (anchor && anchor.href) {
        e.preventDefault();
        if (
          anchor.href.startsWith("http://") ||
          anchor.href.startsWith("https://")
        ) {
          resolvedOpenExternal(anchor.href);
        }
        // Non-http(s) links (file://, relative, etc.) are silently swallowed.
      }
    };

    bodyContainer.addEventListener("click", handleClick);
    return () => bodyContainer.removeEventListener("click", handleClick);
  }, []);

  const handleGhBtnClick = () => {
    if (t.url) {
      resolvedOpenExternal(t.url);
    }
  };

  return (
    <>
      <div className="detail-accent-bar"></div>

      <header className="detail-header">
        <div className="detail-head-top">
          <span id="detail-id" className="detail-id">{t.id ?? ""}</span>
          {t.project_path && (
            <span className="detail-project-name">{t.project_path}</span>
          )}
        </div>
        <h1 id="detail-title" className="detail-title">{t.title ?? ""}</h1>
        <div className="detail-sub-row">
          <span id="detail-status-pill" className="detail-status-pill">{t.status ?? ""}</span>
          {(t.labels ?? []).map((label) => (
            <span key={label} className="card-label-chip">{label}</span>
          ))}
        </div>
      </header>

      <div className="detail-body-scroll sb-scroll">
        <div
          id="detail-body-md"
          className="detail-body-md"
          ref={bodyContainerRef}
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      </div>

      <footer className="detail-footer">
        <button className="detail-btn-primary" id="detail-gh-btn" type="button" onClick={handleGhBtnClick}>
          Issue
        </button>
        {t.pull_request != null && (
          <button
            className="detail-btn-primary"
            id="detail-pr-btn"
            type="button"
            onClick={() => { if (t.pull_request?.url) resolvedOpenExternal(t.pull_request.url); }}
          >
            Pull Request
          </button>
        )}
      </footer>
    </>
  );
}
