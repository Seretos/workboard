import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { DetailView } from "./detail/DetailView";
import type { DetailTicket } from "./types";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);

  // Listen for ticket data pushed from main via IPC.
  // Guard: window.detail is only available in Electron (injected by preload).
  const win = window as Window & typeof globalThis;
  if (typeof win.detail !== "undefined" && win.detail) {
    win.detail.onTicketDetailData((ticket: unknown) => {
      root.render(<DetailView ticket={ticket as DetailTicket} />);
    });
  }
}
