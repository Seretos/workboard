import React from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketsClient } from "../client/TicketsClient";
import { TicketList, type ViewMode } from "./TicketList";
import { StatusBar } from "./StatusBar";

interface Props {
  tickets: TicketRow[];
  status: string;
  ticketCount: string;
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

export function TicketBoard({ tickets, status, ticketCount, presenter, client, onRefresh, activeTicketId }: Props): React.ReactElement {
  const [viewMode, setViewMode] = React.useState<ViewMode>(loadViewMode);

  function selectViewMode(mode: ViewMode): void {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore quota errors
    }
  }

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
      </header>
      <TicketList tickets={tickets} presenter={presenter} client={client} onRefresh={onRefresh} activeTicketId={activeTicketId} viewMode={viewMode} />
      <StatusBar status={status} />
    </>
  );
}
