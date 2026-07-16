import type { TicketRow, Viewer } from "./types";

export interface FilterSettings {
  assignedToMeOnly: boolean;
}

export const DEFAULT_FILTER_SETTINGS: FilterSettings = { assignedToMeOnly: false };

export const FILTER_SETTINGS_STORAGE_KEY = "ticket-filter-settings";

export interface UnresolvedProject {
  project_id: string;
  project_path: string;
}

export interface ApplyFiltersResult {
  tickets: TicketRow[];
  unresolvedProjects: UnresolvedProject[];
}

export function applyFilters(
  tickets: TicketRow[],
  settings: FilterSettings,
  viewer: Viewer | null | undefined
): ApplyFiltersResult {
  if (!settings.assignedToMeOnly) {
    return { tickets, unresolvedProjects: [] };
  }

  const filtered: TicketRow[] = [];
  const unresolvedProjects: UnresolvedProject[] = [];
  const seenProjectIds = new Set<string>();

  for (const ticket of tickets) {
    const identity = viewer?.[ticket.provider as keyof Viewer];
    if (identity === null || identity === undefined) {
      if (!seenProjectIds.has(ticket.project_id)) {
        seenProjectIds.add(ticket.project_id);
        unresolvedProjects.push({ project_id: ticket.project_id, project_path: ticket.project_path });
      }
      continue;
    }
    if ((ticket.assignees ?? []).includes(identity)) {
      filtered.push(ticket);
    }
  }

  return { tickets: filtered, unresolvedProjects };
}
