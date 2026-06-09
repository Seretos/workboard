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

  const presenterRef = useRef<DetailPresenter | null>(null);
  if (!presenterRef.current) {
    // window.detail is injected by the Electron preload; absent in browser context.
    if (typeof window !== "undefined" && (window as Window & typeof globalThis).detail) {
      presenterRef.current = new ElectronDetailPresenter();
    } else {
      presenterRef.current = new BrowserDetailPresenter(setSelectedTicket);
    }
  }
  const presenter = presenterRef.current;

  const isElectronDetailWindow =
    typeof window !== "undefined" &&
    (window as Window & typeof globalThis).detail !== undefined;

  return (
    <>
      <App client={client} presenter={presenter} />
      {!isElectronDetailWindow && selectedTicket && (
        <DetailModal ticket={selectedTicket} onClose={() => setSelectedTicket(null)} />
      )}
    </>
  );
}
