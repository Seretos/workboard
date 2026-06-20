import type { DetailPresenter } from "./DetailPresenter";
import type { DetailTicket } from "../types";

export class ElectronDetailPresenter implements DetailPresenter {
  private onActiveIdChange: (id: string | null) => void;
  private activeId: string | null = null;

  constructor(onActiveIdChange: (id: string | null) => void = () => {}) {
    this.onActiveIdChange = onActiveIdChange;
  }

  open(ticket: DetailTicket): void {
    const id = ticket.id ?? null;
    this.activeId = id;
    this.onActiveIdChange(id);
    window.detail.openTicketDetail(ticket);
    // NOTE: activeId is only cleared when another ticket is opened or when close() is
    // called.  The Electron preload exposes no window-closed/hidden event on the detail
    // surface, so we cannot clear activeId automatically when the detail window is
    // dismissed.  This is a known limitation: the --active border on the card persists in
    // Electron mode until close() is called or a different ticket is opened.  Future fix:
    // expose an "onDetailClosed" listener in preload.ts and call onActiveIdChange(null).
  }

  close(): void {
    this.activeId = null;
    this.onActiveIdChange(null);
    // NOTE: closing the separate Electron detail window over IPC is out of scope here;
    // clearing activeId is sufficient to fix the poll re-open regression.
  }

  getActiveId(): string | null {
    return this.activeId;
  }
}
