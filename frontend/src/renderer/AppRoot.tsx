import React, { useState, useRef } from "react";
import type { TicketsClient } from "./client/TicketsClient";
import type { DetailPresenter } from "./detail/DetailPresenter";
import type { DetailTicket } from "./types";
import { ElectronDetailPresenter } from "./detail/ElectronDetailPresenter";
import { BrowserDetailPresenter } from "./detail/BrowserDetailPresenter";
import { App } from "./components/App";
import { DetailModal } from "./components/DetailModal";

interface Props {
  client: TicketsClient;
}

export function AppRoot({ client }: Props): React.ReactElement {
  const [selectedTicket, setSelectedTicket] = useState<DetailTicket | null>(null);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);

  const presenterRef = useRef<DetailPresenter | null>(null);
  if (!presenterRef.current) {
    // window.detail is injected by the Electron preload; absent in browser context.
    if (typeof window !== "undefined" && (window as Window & typeof globalThis).detail) {
      // NOTE: The Electron preload (preload.ts) exposes no close/blur/hidden event on
      // window.detail, so there is no frontend-only way to clear activeTicketId when the
      // separate detail window is closed.  Clearing the --active border on detail-window
      // close is therefore a known limitation in Electron mode (it clears correctly in
      // browser/modal mode via the onClose callback below).  To fix this properly, expose
      // a "onDetailClosed" IPC listener in the preload and call setActiveTicketId(null)
      // here — but that requires new IPC plumbing and is out of scope for this ticket.
      presenterRef.current = new ElectronDetailPresenter(setActiveTicketId);
    } else {
      presenterRef.current = new BrowserDetailPresenter(setSelectedTicket, setActiveTicketId);
    }
  }
  const presenter = presenterRef.current;

  const isElectronDetailWindow =
    typeof window !== "undefined" &&
    (window as Window & typeof globalThis).detail !== undefined;

  return (
    <>
      <App client={client} presenter={presenter} activeTicketId={activeTicketId} />
      {!isElectronDetailWindow && selectedTicket && (
        <DetailModal ticket={selectedTicket} onClose={() => { setSelectedTicket(null); setActiveTicketId(null); }} />
      )}
    </>
  );
}
