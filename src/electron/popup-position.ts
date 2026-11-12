export type PopupMoveDirection = "up" | "down" | "left" | "right";

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const ANCHORS = {
  center: [0.5, 0.5],
  topLeft: [0, 0], topMiddle: [0.5, 0], topRight: [1, 0],
  bottomLeft: [0, 1], bottomMiddle: [0.5, 1], bottomRight: [1, 1],
} as const;
type Position = keyof typeof ANCHORS;

const MOVES = {
  center: { up: "topMiddle", down: "bottomMiddle", left: "center", right: "center" },
  topLeft: { up: "topLeft", down: "bottomLeft", left: "topLeft", right: "topMiddle" },
  topMiddle: { up: "topMiddle", down: "center", left: "topLeft", right: "topRight" },
  topRight: { up: "topRight", down: "bottomRight", left: "topMiddle", right: "topRight" },
  bottomLeft: { up: "topLeft", down: "bottomLeft", left: "bottomLeft", right: "bottomMiddle" },
  bottomMiddle: { up: "center", down: "bottomMiddle", left: "bottomLeft", right: "bottomRight" },
  bottomRight: { up: "topRight", down: "bottomRight", left: "bottomMiddle", right: "bottomRight" },
} as const satisfies Record<Position, Record<PopupMoveDirection, Position>>;

/** Resolve from actual bounds so dragging, resizing, and display changes stay in sync. */
export function nextPopupPosition(bounds: Bounds, workArea: Bounds, direction: PopupMoveDirection) {
  const availableWidth = Math.max(0, workArea.width - bounds.width);
  const availableHeight = Math.max(0, workArea.height - bounds.height);
  const point = (position: Position) => {
    const [column, row] = ANCHORS[position];
    return {
      x: Math.round(workArea.x + column * availableWidth),
      y: Math.round(workArea.y + row * availableHeight),
    };
  };

  let nearest: Position = "center";
  let distance = Infinity;
  for (const position of ["center", "topLeft", "topMiddle", "topRight", "bottomLeft", "bottomMiddle", "bottomRight"] as const) {
    const { x, y } = point(position);
    const candidateDistance = (bounds.x - x) ** 2 + (bounds.y - y) ** 2;
    if (candidateDistance < distance) {
      nearest = position;
      distance = candidateDistance;
    }
  }
  return point(MOVES[nearest][direction]);
}
