import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { ElectronTicketsClient } from "./client/ElectronTicketsClient";
import { BrowserTicketsClient } from "./client/BrowserTicketsClient";
import { AppRoot } from "./AppRoot";

const client =
  typeof window !== "undefined" && (window as Window & typeof globalThis).backend
    ? new ElectronTicketsClient()
    : new BrowserTicketsClient();

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<AppRoot client={client} />);
}
