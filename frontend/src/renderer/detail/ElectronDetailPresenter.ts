import type { DetailPresenter } from "./DetailPresenter";
import type { DetailTicket } from "../types";

export class ElectronDetailPresenter implements DetailPresenter {
  private onActiveIdChange: (id: string | null) => void;
  private activeId: string | null = null;

  constructor(onActiveIdChange: (id: string | null) => void = () => {}) {
    this.onActiveIdChange = onActiveIdChange;
    // Subscribe to non-renderer-initiated closes (Alt+F4, tray hide) so that
    // the active-card highlight is cleared whenever the window is hidden
    // externally — not just when close() is called explicitly.
    window.detail.onDetailClosed?.(() => {
      this.activeId = null;
      this.onActiveIdChange(null);
    });
  }

  open(ticket: DetailTicket): void {
    const id = ticket.id ?? null;
    this.activeId = id;
    this.onActiveIdChange(id);
    window.detail.openTicketDetail(ticket);
  }

  close(): void {
    this.activeId = null;
    this.onActiveIdChange(null);
    // Send the hide request to main — optional chaining keeps existing unit-test
    // stubs working when hideTicketDetail is not stubbed.
    window.detail.hideTicketDetail?.();
  }

  getActiveId(): string | null {
    return this.activeId;
  }
}
