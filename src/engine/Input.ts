/**
 * Keyboard / mouse state with per-frame edge detection and pointer-lock management.
 * Listens on `window` so it keeps working while UI elements hold DOM focus.
 */
const GAME_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ControlLeft', 'ShiftLeft', 'KeyE', 'KeyR', 'KeyF', 'KeyQ', 'KeyC', 'KeyG']);

export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  readonly buttons = [false, false, false];
  private readonly buttonPressed = [false, false, false];
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** When true the game accepts input without pointer lock (automation / fallback). */
  virtualLock = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (this.active && GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.active || e.button > 2) return;
      this.buttons[e.button] = true;
      this.buttonPressed[e.button] = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button <= 2) this.buttons[e.button] = false;
    });
    document.addEventListener('wheel', (e) => {
      if (this.active) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('contextmenu', (e) => {
      if (this.active) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.reset();
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockChange?.(false));
  }

  /** True while gameplay input should be processed. */
  get active(): boolean {
    return this.locked || this.virtualLock;
  }

  /** Must be called from a user gesture. */
  requestLock(): void {
    if (this.locked) return;
    try {
      const result = this.canvas.requestPointerLock({ unadjustedMovement: true }) as unknown;
      if (result instanceof Promise) {
        result.catch(() => {
          // raw input unsupported: retry with default acceleration
          try {
            const retry = this.canvas.requestPointerLock() as unknown;
            if (retry instanceof Promise) retry.catch(() => this.onLockChange?.(false));
          } catch {
            this.onLockChange?.(false);
          }
        });
      }
    } catch {
      this.onLockChange?.(false);
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  buttonDown(b: number): boolean {
    return this.buttons[b];
  }

  buttonWasPressed(b: number): boolean {
    return this.buttonPressed[b];
  }

  /** Clear per-frame edges and deltas. Call once at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.buttonPressed[0] = this.buttonPressed[1] = this.buttonPressed[2] = false;
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }

  reset(): void {
    this.keys.clear();
    this.pressed.clear();
    this.buttons[0] = this.buttons[1] = this.buttons[2] = false;
    this.endFrame();
  }

  // --- automation hooks (used by the built-in self test, never by gameplay code) ---
  press(code: string): void {
    this.keys.add(code);
    this.pressed.add(code);
  }
  release(code: string): void {
    this.keys.delete(code);
  }
  click(button: number, down: boolean): void {
    this.buttons[button] = down;
    if (down) this.buttonPressed[button] = true;
  }
}
