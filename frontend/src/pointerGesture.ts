export const POINTER_CLICK_TOLERANCE_PX = 5;

export type PointerGestureInput = {
  pointerId: number;
  clientX: number;
  clientY: number;
  button?: number;
};

type ActivePointer = Pick<PointerGestureInput, 'clientX' | 'clientY'>;

/**
 * Tracks the pointer sequence that starts on the image canvas.
 *
 * OpenSeadragon owns the actual pan gesture. This class only decides whether
 * the browser's follow-up click still represents a click, so it can be used
 * from React event handlers without coupling the decision to a viewer.
 */
export class PointerGesture {
  private activePointers = new Map<number, ActivePointer>();
  private suppressClick = false;

  begin(input: PointerGestureInput) {
    if (input.button !== undefined && input.button !== 0) return;

    if (this.activePointers.size === 0) {
      // A new, independent pointer sequence starts a fresh click decision.
      this.suppressClick = false;
    } else if (!this.activePointers.has(input.pointerId)) {
      // A second pointer means this sequence is a gesture, even if neither
      // pointer travels far enough to cross the movement threshold.
      this.suppressClick = true;
    }
    this.activePointers.set(input.pointerId, {
      clientX: input.clientX,
      clientY: input.clientY,
    });
  }

  move(input: Pick<PointerGestureInput, 'pointerId' | 'clientX' | 'clientY'>) {
    const start = this.activePointers.get(input.pointerId);
    if (!start) return false;
    const moved = Math.hypot(input.clientX - start.clientX, input.clientY - start.clientY) > POINTER_CLICK_TOLERANCE_PX;
    if (moved) this.suppressClick = true;
    return moved;
  }

  end(pointerId: number) {
    this.activePointers.delete(pointerId);
  }

  cancel(pointerId: number) {
    if (!this.activePointers.delete(pointerId)) return;
    // A canceled pointer must never turn into a selection click.
    this.suppressClick = true;
  }

  cancelAll() {
    if (this.activePointers.size > 0) this.suppressClick = true;
    this.activePointers.clear();
  }

  get activePointerCount() {
    return this.activePointers.size;
  }

  shouldSuppressClick() {
    return this.suppressClick;
  }

  /** Consume the browser click that belongs to the completed gesture. */
  consumeClick() {
    const suppressed = this.suppressClick;
    this.suppressClick = false;
    return suppressed;
  }
}
