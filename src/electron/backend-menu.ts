import { BACKEND_LABELS, BLINK_BACKENDS, type BlinkBackend } from "../core/types";

export type BackendChoice = {
  readonly label: string;
  readonly type: "radio";
  readonly checked: boolean;
  readonly click: () => void;
};

export type BackendMenu = {
  readonly label: string;
  readonly submenu: readonly BackendChoice[];
};

export function backendMenu(
  selected: BlinkBackend,
  onSelect: (backend: BlinkBackend) => void,
): BackendMenu {
  return {
    label: `Backend: ${BACKEND_LABELS[selected]}`,
    submenu: BLINK_BACKENDS.map((backend) => ({
      label: BACKEND_LABELS[backend],
      type: "radio",
      checked: selected === backend,
      click: () => {
        onSelect(backend);
      },
    })),
  };
}
