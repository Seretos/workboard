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
    // NOTE: activeId is only cleared when another ticket is opened (or in browser mode
    // when the modal is closed).  The Electron preload exposes no window-closed/hidden
    // event on the detail surface, so we cannot clear activeId automatically when the
    // detail window is dismissed.  This is a known limitation: the --active border on the
    // card persists in Electron mode until a different ticket is opened.  Future fix:
    // expose an "onDetailClosed" listener in preload.ts and call onActiveIdChange(null).
  }

  getActiveId(): string | null {
    return this.activeId;
  }
}
