import React from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketsClient } from "../client/TicketsClient";
import { TicketCard } from "./TicketCard";

interface Props {
  tickets: TicketRow[];
  presenter: DetailPresenter;
  client: TicketsClient;
  onRefresh: () => void;
  activeTicketId: string | null;
}

export function TicketList({ tickets, presenter, client, onRefresh, activeTicketId }: Props): React.ReactElement {
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("collapsed-projects");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  function toggleCollapsed(projectId: string): void {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        localStorage.setItem("collapsed-projects", JSON.stringify([...next]));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  }

  // Group tickets by project_id, preserving insertion order.
  const groups = new Map<string, TicketRow[]>();
  for (const ticket of tickets) {
    const key = ticket.project_id ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.push(ticket);
    } else {
      groups.set(key, [ticket]);
    }
  }

  const items: React.ReactElement[] = [];
  for (const [projectId, groupTickets] of groups) {
    const projectPath = groupTickets[0].project_path ?? "";
    const isCollapsed = collapsedProjects.has(projectId);
    items.push(
      <li
        key={`header-${projectId}`}
        className={`project-group-header${isCollapsed ? " project-group-header--collapsed" : ""}`}
        onClick={() => toggleCollapsed(projectId)}
      >
        <span className="group-collapse-icon">{isCollapsed ? "▸" : "▾"}</span>
        <span className="group-label">{projectPath}</span>
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
