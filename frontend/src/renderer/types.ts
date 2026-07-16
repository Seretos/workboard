// Shared types for the renderer.

export interface TicketRow {
  id: string;
  title: string;
  status: string;
  url: string;
  body?: string;
  labels: string[];
  provider: string;
  assignees: string[];
  project_id: string;
  project_path: string;
  board_id: string | null;
  pull_request?: {
    number: number;
    url: string;
    status: string;
    draft: boolean;
  } | null;
  worktree: {
    id: string;
    path: string;
    branch: string;
    status: string;
  } | null;
}

export interface PollErrors {
  rate_limited: boolean;
  retry_after: number | null;
  failed_projects: string[];
}

export interface Viewer {
  github: string | null;
  gitlab: string | null;
  azuredevops: string | null;
}

export interface TicketsResponse {
  tickets: TicketRow[];
  poll_errors: PollErrors | null;
  viewer: Viewer;
}

export interface DetailTicket {
  id?: string;
  title?: string;
  body?: string;
  url?: string;
  status?: string;
  pull_request?: {
    url: string;
    status: string;
  } | null;
  labels?: string[];
  project_id?: string;
  project_path?: string;
}
