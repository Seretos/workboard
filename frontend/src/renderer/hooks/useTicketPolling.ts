import { useState, useEffect, useRef } from "react";
import type { TicketsClient } from "../client/TicketsClient";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketRow, TicketsResponse, Viewer } from "../types";

const DEFAULT_VIEWER: Viewer = { github: null, gitlab: null, azuredevops: null };

export const POLL_INTERVAL_MS = 300_000;

// Bounds a single /tickets round-trip. Generous enough to cover the
// backend's own per-provider timeouts (30s, run concurrently) plus
// overhead, while still guaranteeing the UI surfaces an error instead of
// hanging on "Lädt Tickets…" forever if the backend process is alive but
// unresponsive.
const FETCH_TIMEOUT_MS = 60_000;

export interface PollingState {
  tickets: TicketRow[];
  status: string;
  ticketCount: string;
  viewer: Viewer;
  refresh: () => void;
}

export function useTicketPolling(
  client: TicketsClient,
  presenter: DetailPresenter
): PollingState {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [status, setStatus] = useState<string>("");
  const [ticketCount, setTicketCount] = useState<string>("");
  const [viewer, setViewer] = useState<Viewer>(DEFAULT_VIEWER);

  const pollIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backoffTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to the last good ticket list for stale-preservation on rate-limit.
  const lastTicketsRef = useRef<TicketRow[]>([]);
  // Timestamp of the last focus-triggered refresh (0 = never). Used to throttle
  // repeated window-focus events to at most one load per 30 seconds.
  const lastFocusRefreshRef = useRef<number>(0);

  // pausePollForBackoff must be stable across renders — use a ref to avoid
  // re-creating it on every render while still seeing current ref values.
  const pausePollForBackoffRef = useRef<(retryAfterSeconds: number | null) => void>(
    () => {}
  );

  function notifyPresenter(tickets: TicketRow[]): void {
    const activeId = presenter.getActiveId();
    if (activeId === null) return;
    const ticket = tickets.find((t) => t.id === activeId);
    if (ticket !== undefined) {
      presenter.open(ticket);
    }
  }

  const loadTicketsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    function startPoll(): void {
      pollIdRef.current = setInterval(() => {
        loadTicketsRef.current();
      }, POLL_INTERVAL_MS);
    }

    function pausePollForBackoff(retryAfterSeconds: number | null): void {
      if (pollIdRef.current !== null) clearInterval(pollIdRef.current);
      pollIdRef.current = null;
      if (backoffTimeoutIdRef.current !== null) clearTimeout(backoffTimeoutIdRef.current);
      const delay = (retryAfterSeconds ?? 300) * 1000;
      backoffTimeoutIdRef.current = setTimeout(() => {
        backoffTimeoutIdRef.current = null;
        loadTicketsRef.current();
        startPoll();
      }, delay);
    }

    pausePollForBackoffRef.current = pausePollForBackoff;

    async function loadTickets(): Promise<void> {
      setStatus("Lädt Tickets…");

      let data: TicketsResponse;
      try {
        const response = await client.fetchJson("/tickets", undefined, FETCH_TIMEOUT_MS);
        if (!response.ok) {
          throw new Error(`Backend antwortete mit HTTP ${response.status}`);
        }
        data = response.data as TicketsResponse;
      } catch (err) {
        setStatus(
          `Fehler beim Laden: ${err instanceof Error ? err.message : String(err)}`
        );
        setTicketCount("!");
        return;
      }

      const poll_errors = data.poll_errors;

      if (poll_errors?.rate_limited) {
        if (data.tickets.length > 0) {
          setTickets(data.tickets);
          lastTicketsRef.current = data.tickets;
          notifyPresenter(data.tickets);
          setTicketCount(String(data.tickets.length));
        }
        // else: stale preservation — don't update tickets/ticketCount
        const time = new Date().toLocaleTimeString("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
        });
        setStatus(`Rate-Limit erreicht – Stand: ${time}`);
        pausePollForBackoff(poll_errors.retry_after);
        return;
      }

      if (poll_errors !== null && poll_errors !== undefined) {
        // Partial failure
        setTickets(data.tickets);
        lastTicketsRef.current = data.tickets;
        notifyPresenter(data.tickets);
        setViewer(data.viewer ?? DEFAULT_VIEWER);
        setStatus(`${poll_errors.failed_projects.length} Projekt(e) nicht geladen`);
      } else {
        // Full success
        setTickets(data.tickets);
        lastTicketsRef.current = data.tickets;
        notifyPresenter(data.tickets);
        setViewer(data.viewer ?? DEFAULT_VIEWER);
        setStatus(data.tickets.length === 0 ? "Keine offenen Tickets" : "");
      }

      setTicketCount(String(data.tickets.length));
    }

    loadTicketsRef.current = loadTickets;

    // Initial load + poll setup
    loadTickets();
    startPoll();

    // Register backend-crashed listener
    client.onBackendCrashed((code: number | null) => {
      if (pollIdRef.current !== null) clearInterval(pollIdRef.current);
      pollIdRef.current = null;
      if (backoffTimeoutIdRef.current !== null) clearTimeout(backoffTimeoutIdRef.current);
      backoffTimeoutIdRef.current = null;
      setStatus(`Backend abgestürzt (Code ${code ?? "?"})`);
    });

    // Focus-refresh: when the user brings the window to front, trigger an
    // immediate load — unless a backoff is active (we're rate-limited) or
    // the last focus-refresh was less than 30 seconds ago.
    function handleFocus(): void {
      if (backoffTimeoutIdRef.current !== null) return; // backoff active — skip
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 30_000) return; // within 30s throttle
      lastFocusRefreshRef.current = now;
      loadTicketsRef.current();
    }
    window.addEventListener("focus", handleFocus);

    // Cleanup on unmount
    return () => {
      if (pollIdRef.current !== null) clearInterval(pollIdRef.current);
      if (backoffTimeoutIdRef.current !== null) clearTimeout(backoffTimeoutIdRef.current);
      window.removeEventListener("focus", handleFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    loadTicketsRef.current();
  };

  return { tickets, status, ticketCount, viewer, refresh };
}
