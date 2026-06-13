// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTicketPolling, POLL_INTERVAL_MS } from "./useTicketPolling";
import type { TicketsClient } from "../client/TicketsClient";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { DetailTicket } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTicket(overrides: {
  id?: string;
  project_id: string;
  project_path: string;
  pull_request?: { number: number; url: string; status: string; draft: boolean } | null;
}) {
  return {
    id: overrides.id ?? "1",
    title: "Test ticket",
    status: "open",
    url: "https://example.com",
    labels: [],
    provider: "github",
    project_id: overrides.project_id,
    project_path: overrides.project_path,
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
  };
}

function makeSuccessResponse(tickets: ReturnType<typeof makeTicket>[]) {
  return { ok: true, status: 200, data: { tickets, poll_errors: null } };
}

function makeRateLimitResponse(
  tickets: ReturnType<typeof makeTicket>[],
  retry_after: number | null,
  failed_projects: string[] = []
) {
  return {
    ok: true,
    status: 200,
    data: {
      tickets,
      poll_errors: { rate_limited: true, retry_after, failed_projects },
    },
  };
}

function makeMockClient(
  fetchJson: ReturnType<typeof vi.fn>,
  onBackendCrashed?: ReturnType<typeof vi.fn>
): TicketsClient {
  return {
    fetchJson,
    onBackendCrashed: onBackendCrashed ?? vi.fn(),
  };
}

function makeMockPresenter(): DetailPresenter {
  return { open: vi.fn() as (ticket: DetailTicket) => void };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTicketPolling — initial load", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("POLL_INTERVAL_MS equals 300_000", () => {
    expect(POLL_INTERVAL_MS).toBe(300_000);
  });

  it("after successful fetch: tickets and ticketCount reflect the response", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse(tickets));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    // Wait for the async load to complete.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.tickets).toHaveLength(2);
    expect(result.current.ticketCount).toBe("2");
    expect(result.current.status).toBe("");
  });

  it("empty ticket list: status is 'Keine offenen Tickets' and ticketCount is '0'", async () => {
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([]));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.tickets).toHaveLength(0);
    expect(result.current.ticketCount).toBe("0");
    expect(result.current.status).toBe("Keine offenen Tickets");
  });

  it("backend HTTP error: ticketCount is '!' and status contains 'Fehler' and the status code", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, data: null });
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.ticketCount).toBe("!");
    expect(result.current.status).toContain("Fehler");
    expect(result.current.status).toContain("503");
  });

  it("network throw: ticketCount is '!' and status contains the error message", async () => {
    const fetchJson = vi.fn().mockRejectedValue(new Error("Netzwerkfehler"));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.ticketCount).toBe("!");
    expect(result.current.status).toContain("Netzwerkfehler");
  });

  it("partial failure: status shows N Projekt(e) nicht geladen", async () => {
    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const partialResponse = {
      ok: true,
      status: 200,
      data: {
        tickets: [ticket],
        poll_errors: { rate_limited: false, retry_after: null, failed_projects: ["proj-b", "proj-c"] },
      },
    };
    const fetchJson = vi.fn().mockResolvedValue(partialResponse);
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.tickets).toHaveLength(1);
    expect(result.current.status).toContain("2 Projekt(e) nicht geladen");
    expect(result.current.ticketCount).toBe("1");
  });
});

describe("useTicketPolling — polling interval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetchJson is called a second time after one poll interval", async () => {
    vi.useFakeTimers();

    const tickets = [makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" })];
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse(tickets));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(fetchJson.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Cleanup
    act(() => { capturedCrashCb?.(null); });
  });
});

describe("useTicketPolling — backend crashed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("crash with numeric code: status contains 'abgestürzt' and the code", async () => {
    vi.useFakeTimers();

    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    act(() => { capturedCrashCb!(42); });

    expect(result.current.status).toContain("abgestürzt");
    expect(result.current.status).toContain("42");
  });

  it("crash with null code: status contains '?' without throwing", async () => {
    vi.useFakeTimers();

    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    expect(() => {
      act(() => { capturedCrashCb!(null); });
    }).not.toThrow();

    expect(result.current.status).toContain("?");
  });

  it("regression: crash clears poll — fetchJson not called again after crash", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([ticket]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });
    const callsAfterInit = fetchJson.mock.calls.length;

    act(() => { capturedCrashCb!(7); });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });

    expect(fetchJson.mock.calls.length).toBe(callsAfterInit);
  });
});

describe("useTicketPolling — rate-limit resilience", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rate_limited: status contains 'Rate-Limit'", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    // First load
    await act(async () => {
      await Promise.resolve();
    });

    // Trigger second poll (rate-limited)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(result.current.status).toContain("Rate-Limit");
  });

  it("rate_limited with empty data.tickets: stale tickets preserved", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.tickets).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    // Stale tickets must still be there
    expect(result.current.tickets).toHaveLength(1);
  });

  it("rate_limited: poll paused — no extra calls within backoff window", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValue(makeRateLimitResponse([], 600, []));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    // initial load
    await act(async () => {
      await Promise.resolve();
    });

    // trigger rate-limit
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // advance 500s more — still within the 600s backoff window
    // (POLL_INTERVAL_MS is 300s, so 3× would overshoot the 600s backoff;
    // use a fixed 500_000ms that stays safely inside it)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500_000);
    });

    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);
    act(() => { capturedCrashCb!(null); });
  });

  it("rate_limited: poll resumes after retry_after elapses", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []))
      .mockResolvedValue(makeSuccessResponse([ticket]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    // trigger rate-limit
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // advance past retry_after
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    });

    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsAfterRateLimit);
    act(() => { capturedCrashCb!(null); });
  });

  it("retry_after null: uses 5-minute default backoff (300s)", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], null, []))
      .mockResolvedValue(makeSuccessResponse([ticket]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // 299s — should not have resumed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299_000);
    });
    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);

    // +1001ms more — now past 300s default
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsAfterRateLimit);

    act(() => { capturedCrashCb!(null); });
  });

  it("crash during backoff: fetchJson not called after retry_after elapses and crash status persists", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []))
      .mockResolvedValue(makeSuccessResponse([ticket]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    const { result } = renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    // trigger rate-limit
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // crash during backoff
    act(() => { capturedCrashCb!(99); });
    expect(result.current.status).toContain("abgestürzt");
    expect(result.current.status).toContain("99");

    // advance past retry_after — backoff should be cancelled
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    });

    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);
    expect(result.current.status).toContain("abgestürzt");
    expect(result.current.status).toContain("99");
  });
});

describe("useTicketPolling — focus refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("focus event triggers one extra fetchJson call beyond the initial load", async () => {
    const tickets = [makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" })];
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse(tickets));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    // Wait for the initial load to complete.
    await act(async () => {
      await Promise.resolve();
    });
    const callsAfterInit = fetchJson.mock.calls.length;

    // Dispatch a focus event — should trigger an immediate load.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchJson.mock.calls.length).toBe(callsAfterInit + 1);
  });

  it("a second focus within 30s is throttled and produces no extra call", async () => {
    const tickets = [makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" })];
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse(tickets));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    // First focus — should fire.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    const callsAfterFirstFocus = fetchJson.mock.calls.length;

    // Advance 10s (still within the 30s throttle window).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Second focus — should be suppressed.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchJson.mock.calls.length).toBe(callsAfterFirstFocus);
  });

  it("a focus after advancing >30s triggers another call", async () => {
    const tickets = [makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" })];
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse(tickets));
    const client = makeMockClient(fetchJson);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    await act(async () => {
      await Promise.resolve();
    });

    // First focus.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    const callsAfterFirstFocus = fetchJson.mock.calls.length;

    // Advance past the 30s throttle window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    // Second focus — 30s elapsed, should fire.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(fetchJson.mock.calls.length).toBe(callsAfterFirstFocus + 1);
  });

  it("no focus-refresh while in backoff (rate-limited)", async () => {
    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      // The poll-interval call that triggers the rate-limit.
      .mockResolvedValue(makeRateLimitResponse([], 600, []));
    let capturedCrashCb: ((code: number | null) => void) | undefined;
    const onBackendCrashed = vi.fn((cb: (code: number | null) => void) => {
      capturedCrashCb = cb;
    });
    const client = makeMockClient(fetchJson, onBackendCrashed);
    const presenter = makeMockPresenter();

    renderHook(() => useTicketPolling(client, presenter));

    // Initial load.
    await act(async () => {
      await Promise.resolve();
    });

    // Trigger the rate-limit via the poll interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    // Now in 600s backoff. Record current call count.
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // Advance 31s (past throttle window) then fire focus.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // The focus must have been suppressed — we are in backoff.
    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);

    // Cleanup: crash the backend so the backoff timeout is cancelled.
    act(() => { capturedCrashCb?.(null); });
  });
});
