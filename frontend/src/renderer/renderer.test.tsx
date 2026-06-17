// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketList } from "./components/TicketList";
import { TicketCard } from "./components/TicketCard";
import type { TicketRow } from "./types";
import type { DetailPresenter } from "./detail/DetailPresenter";
import type { DetailTicket } from "./types";
import type { TicketsClient } from "./client/TicketsClient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTicket(overrides: {
  id?: string;
  title?: string;
  status?: string;
  url?: string;
  body?: string;
  labels?: string[];
  provider?: string;
  project_id: string;
  project_path: string;
  pull_request?: { number: number; url: string; status: string; draft: boolean } | null;
}): TicketRow {
  return {
    id: overrides.id ?? "1",
    title: overrides.title ?? "Test ticket",
    status: overrides.status ?? "open",
    url: overrides.url ?? "https://example.com",
    body: overrides.body,
    labels: overrides.labels ?? [],
    provider: overrides.provider ?? "github",
    project_id: overrides.project_id,
    project_path: overrides.project_path,
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
    worktree: null,
  };
}

function makePresenter(): { presenter: DetailPresenter; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn() as (ticket: DetailTicket) => void;
  return { presenter: { open }, open };
}

function makeClient(): TicketsClient {
  return {
    fetchJson: vi.fn().mockResolvedValue({ ok: true, status: 200, data: null }),
    onBackendCrashed: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// TicketList — grouping
// ---------------------------------------------------------------------------

describe("TicketList — grouping", () => {
  it("two projects: renders exactly 2 .project-group-header elements", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const headers = container.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(2);
  });

  it("two projects: first header text includes correct project_path", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const headers = container.querySelectorAll(".project-group-header");
    expect(headers[0].textContent).toContain("/repos/alpha");
    expect(headers[1].textContent).toContain("/repos/beta");
  });

  it("two projects: each header badge shows per-group ticket count", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const badges = container.querySelectorAll(".project-group-header .group-count");
    expect(badges[0].textContent).toBe("2");
    expect(badges[1].textContent).toBe("3");
  });

  it("single project: renders exactly 1 .project-group-header element", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const headers = container.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(1);
  });

  it("all 5 ticket cards appear after headers (no interleaving with wrong group)", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const list = container.querySelector("ul")!;
    const items = Array.from(list.children);
    // Order: header-A, card-A1, card-A2, header-B, card-B3, card-B4, card-B5
    expect(items).toHaveLength(7);
    expect(items[0].classList.contains("project-group-header")).toBe(true);
    expect(items[1].classList.contains("ticket-card")).toBe(true);
    expect(items[2].classList.contains("ticket-card")).toBe(true);
    expect(items[3].classList.contains("project-group-header")).toBe(true);
    expect(items[4].classList.contains("ticket-card")).toBe(true);
    expect(items[5].classList.contains("ticket-card")).toBe(true);
    expect(items[6].classList.contains("ticket-card")).toBe(true);
  });

  it("empty ticket list: renders nothing (no headers, no cards)", () => {
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={[]} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const list = container.querySelector("ul")!;
    expect(list.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TicketCard / TicketList — PR accent
// ---------------------------------------------------------------------------

describe("TicketList — PR accent", () => {
  it("ticket with pull_request object gets class ticket-card--has-pr", () => {
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 42, url: "https://github.com/x/y/pull/42", status: "open", draft: false },
      }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);
  });

  it("ticket with pull_request: null does NOT get class ticket-card--has-pr", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", pull_request: null }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(false);
  });

  it("ticket with pull_request field absent (undefined) does NOT get class ticket-card--has-pr", () => {
    const ticket = {
      id: "1",
      title: "Old ticket",
      status: "open",
      url: "https://example.com",
      labels: [] as string[],
      provider: "github",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      // pull_request intentionally absent
    } as TicketRow;
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={[ticket]} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(false);
  });

  it("mixed tickets: only the one with pull_request gets the PR class", () => {
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 7, url: "https://github.com/x/y/pull/7", status: "open", draft: false },
      }),
      makeTicket({
        id: "2",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: null,
      }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const cards = container.querySelectorAll(".ticket-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains("ticket-card--has-pr")).toBe(true);
    expect(cards[1].classList.contains("ticket-card--has-pr")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TicketList — edge cases
// ---------------------------------------------------------------------------

describe("TicketList — edge cases", () => {
  it("same project_id with different project_path: first path wins for header, no crash", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/first" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/second" }),
    ];
    const { presenter } = makePresenter();
    expect(() => {
      const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);
      const headers = container.querySelectorAll(".project-group-header");
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("/repos/first");
    }).not.toThrow();
  });

  it("empty project_path: renders without crash", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "" }),
    ];
    const { presenter } = makePresenter();
    expect(() => {
      const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);
      const headers = container.querySelectorAll(".project-group-header");
      expect(headers).toHaveLength(1);
    }).not.toThrow();
  });

  it("draft pull_request: still gets ticket-card--has-pr (object is non-null)", () => {
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 99, url: "https://github.com/x/y/pull/99", status: "draft", draft: true },
      }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);

    const card = container.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TicketCard — card click opens detail window
// ---------------------------------------------------------------------------

describe("TicketCard — card click", () => {
  it("clicking a ticket card calls presenter.open with the ticket", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;
    expect(card).not.toBeNull();

    await userEvent.click(card);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(ticket);
  });

  it("clicking a card passes the body field to presenter.open", async () => {
    const ticket = makeTicket({
      id: "7",
      body: "This is the ticket description.",
      project_id: "proj-a",
      project_path: "/repos/alpha",
    });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;
    await userEvent.click(card);

    const arg = (open as ReturnType<typeof vi.fn>).mock.calls[0][0] as { body?: string };
    expect(arg.body).toBe("This is the ticket description.");
  });

  it("clicking a card passes the pull_request field to presenter.open", async () => {
    const pr = { number: 10, url: "https://github.com/x/y/pull/10", status: "open", draft: false };
    const ticket = makeTicket({ id: "10", project_id: "proj-a", project_path: "/repos/alpha", pull_request: pr });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;
    await userEvent.click(card);

    const arg = (open as ReturnType<typeof vi.fn>).mock.calls[0][0] as { pull_request: typeof pr };
    expect(arg.pull_request).toEqual(pr);
  });

  it("each card in a multi-card list calls presenter.open with its own ticket", async () => {
    const t1 = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const t2 = makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketList tickets={[t1, t2]} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} />);
    const cards = container.querySelectorAll(".ticket-card") as NodeListOf<HTMLElement>;
    expect(cards).toHaveLength(2);

    await userEvent.click(cards[0]);
    expect((open as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(t1);

    await userEvent.click(cards[1]);
    expect((open as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(t2);
  });
});

// ---------------------------------------------------------------------------
// TicketCard — worktree create / delete behaviour
// ---------------------------------------------------------------------------

function makeTicketWithWorktree(worktreeId: string = "workboard-fix-42-abcd1234"): TicketRow {
  return {
    ...makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" }),
    worktree: { id: worktreeId, path: "/wt/path", branch: "fix/42-test", status: "idle" },
  };
}

describe("TicketCard — create worktree", () => {
  it("clicking 'Worktree erstellen' calls fetchJson with method POST and correct body", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 201, data: { id: "new-id" } });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} />
    );

    const btn = container.querySelector(".card-worktree-btn") as HTMLElement;
    expect(btn).not.toBeNull();
    await userEvent.click(btn);

    expect(fetchJson).toHaveBeenCalledWith(
      "/worktrees",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"project_id":"proj-a"'),
      })
    );
    const callInit = fetchJson.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callInit.body as string);
    expect(body.project_id).toBe("proj-a");
    expect(body.ticket_number).toBe(42);
    expect(body.ticket_title).toBe("Test ticket");
    expect(body.base_branch).toBe("main");
  });

  it("on create success onRefresh is called", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 201, data: {} });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} />
    );

    const btn = container.querySelector(".card-worktree-btn") as HTMLElement;
    await userEvent.click(btn);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("non-ok create response renders error text", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: "Duplicate worktree" },
    });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} />
    );

    const btn = container.querySelector(".card-worktree-btn") as HTMLElement;
    await userEvent.click(btn);

    const errorEl = container.querySelector(".card-worktree-error");
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toContain("Duplicate worktree");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("TicketCard — delete worktree", () => {
  it("clicking 'Worktree löschen' calls fetchJson with method DELETE", async () => {
    const ticket = makeTicketWithWorktree("workboard-fix-42-abcd1234");
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "workboard-fix-42-abcd1234", status: "removed" } });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} />
    );

    const btn = container.querySelector(".card-worktree-btn--delete") as HTMLElement;
    expect(btn).not.toBeNull();
    await userEvent.click(btn);

    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining("/worktrees/workboard-fix-42-abcd1234"),
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("on delete success onRefresh is called", async () => {
    const ticket = makeTicketWithWorktree();
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} />
    );

    const btn = container.querySelector(".card-worktree-btn--delete") as HTMLElement;
    await userEvent.click(btn);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("non-ok delete response renders error text and onRefresh is NOT called", async () => {
    const ticket = makeTicketWithWorktree();
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: "Worktree directory is locked" },
    });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} />
    );

    const btn = container.querySelector(".card-worktree-btn--delete") as HTMLElement;
    await userEvent.click(btn);

    const errorEl = container.querySelector(".card-worktree-error");
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toContain("Worktree directory is locked");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
