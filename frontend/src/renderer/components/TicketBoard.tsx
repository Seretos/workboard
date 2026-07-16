import React from "react";
import type { TicketRow, Viewer } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketsClient } from "../client/TicketsClient";
import { TicketList, type ViewMode } from "./TicketList";
import { StatusBar } from "./StatusBar";
import { applyFilters } from "../filters";
import { useFilterSettings } from "../hooks/useFilterSettings";

interface Props {
  tickets: TicketRow[];
  status: string;
  ticketCount: string;
  viewer: Viewer;
  presenter: DetailPresenter;
  client: TicketsClient;
  onRefresh: () => void;
  activeTicketId: string | null;
}

const VIEW_MODE_STORAGE_KEY = "ticket-view-mode";

function loadViewMode(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return raw === "board" ? "board" : "project";
  } catch {
    return "project";
  }
}

export function TicketBoard({ tickets, status, ticketCount, viewer, presenter, client, onRefresh, activeTicketId }: Props): React.ReactElement {
  const [viewMode, setViewMode] = React.useState<ViewMode>(loadViewMode);
  const [settings, updateSetting] = useFilterSettings();

  function selectViewMode(mode: ViewMode): void {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore quota errors
    }
  }

  const { tickets: filteredTickets, unresolvedProjects } = applyFilters(tickets, settings, viewer);
  const showUnresolvedBanner = settings.assignedToMeOnly && unresolvedProjects.length > 0;

  return (
    <>
      <header className="panel-header">
        <span className="panel-title">workboard</span>
        <span id="ticket-count" className="ticket-count">{ticketCount}</span>
        <div className="view-mode-switch">
          <button
            type="button"
            className={`view-mode-btn${viewMode === "project" ? " view-mode-btn--active" : ""}`}
            onClick={() => selectViewMode("project")}
          >
            Nach Projekten
          </button>
          <button
            type="button"
            className={`view-mode-btn${viewMode === "board" ? " view-mode-btn--active" : ""}`}
            onClick={() => selectViewMode("board")}
          >
            Nach Boards
          </button>
        </div>
        <div className="filter-settings">
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={settings.assignedToMeOnly}
              onChange={(e) => updateSetting("assignedToMeOnly", e.target.checked)}
            />
            Nur mir zugewiesen
          </label>
          {showUnresolvedBanner && (
            <div className="filter-unresolved-banner">
              Identität konnte nicht aufgelöst werden für: {unresolvedProjects.map(p => p.project_path).join(", ")}
            </div>
          )}
        </div>
      </header>
      <TicketList tickets={filteredTickets} presenter={presenter} client={client} onRefresh={onRefresh} activeTicketId={activeTicketId} viewMode={viewMode} />
      <StatusBar status={status} />
    </>
  );
}
