import React from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketsClient } from "../client/TicketsClient";
import { TicketCard } from "./TicketCard";

export type ViewMode = "project" | "board";

interface Props {
  tickets: TicketRow[];
  presenter: DetailPresenter;
  client: TicketsClient;
  onRefresh: () => void;
  activeTicketId: string | null;
  viewMode?: ViewMode;
}

// Sentinel grouping key for tickets with no board_id, used both as the Map
// key and the collapse-toggle key for the "Ohne Board" catch-all group.
const NO_BOARD_KEY = "__no_board__";

// Strips a board_id's provider prefix (everything up to and including the
// first colon) for display. Values without a colon are returned unchanged.
// Exported for direct unit testing.
export function boardLabel(id: string): string {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    return id;
  }
  return id.slice(colonIndex + 1);
}

function useCollapsedSet(storageKey: string): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  function toggle(key: string): void {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  }

  return [collapsed, toggle];
}

export function TicketList({ tickets, presenter, client, onRefresh, activeTicketId, viewMode = "project" }: Props): React.ReactElement {
  const [collapsedProjects, toggleCollapsedProject] = useCollapsedSet("collapsed-projects");
  const [collapsedBoards, toggleCollapsedBoard] = useCollapsedSet("collapsed-boards");

  const collapsedSet = viewMode === "board" ? collapsedBoards : collapsedProjects;
  const toggleCollapsed = viewMode === "board" ? toggleCollapsedBoard : toggleCollapsedProject;

  // Group tickets by project_id or board_id (depending on viewMode), preserving insertion order.
  const groups = new Map<string, TicketRow[]>();
  for (const ticket of tickets) {
    const key = viewMode === "board" ? ticket.board_id ?? NO_BOARD_KEY : ticket.project_id ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.push(ticket);
    } else {
      groups.set(key, [ticket]);
    }
  }

  const items: React.ReactElement[] = [];
  for (const [groupKey, groupTickets] of groups) {
    const label =
      viewMode === "board"
        ? groupKey === NO_BOARD_KEY
          ? "Ohne Board"
          : boardLabel(groupKey)
        : groupTickets[0].project_path ?? "";
    const isCollapsed = collapsedSet.has(groupKey);
    items.push(
      <li
        key={`header-${groupKey}`}
        className={`project-group-header${isCollapsed ? " project-group-header--collapsed" : ""}`}
        onClick={() => toggleCollapsed(groupKey)}
      >
        <span className="group-collapse-icon">{isCollapsed ? "▸" : "▾"}</span>
        <span className="group-label">{label}</span>
        <span className="group-count">{String(groupTickets.length)}</span>
      </li>
    );
    if (!isCollapsed) {
      for (const ticket of groupTickets) {
        items.push(
          <TicketCard
            key={`${ticket.project_id}-${ticket.id}`}
            ticket={ticket}
            presenter={presenter}
            client={client}
            onRefresh={onRefresh}
            isActive={ticket.id === activeTicketId}
          />
        );
      }
    }
  }

  return <ul id="ticket-list">{items}</ul>;
}
