import { create } from "zustand";

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  selectedRows: Record<string, Set<number>>;
  setSelectedRows: (key: string, rows: Set<number>) => void;
  clearSelectedRows: (key: string) => void;
  toggleRow: (key: string, id: number) => void;

  modalOpen: string | null;
  setModalOpen: (modal: string | null) => void;
}

export const useStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  selectedRows: {},
  setSelectedRows: (key, rows) =>
    set((s) => ({ selectedRows: { ...s.selectedRows, [key]: rows } })),
  clearSelectedRows: (key) =>
    set((s) => {
      const { [key]: _, ...rest } = s.selectedRows;
      return { selectedRows: rest };
    }),
  toggleRow: (key, id) =>
    set((s) => {
      const current = s.selectedRows[key] ?? new Set<number>();
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedRows: { ...s.selectedRows, [key]: next } };
    }),

  modalOpen: null,
  setModalOpen: (modal) => set({ modalOpen: modal }),
}));
