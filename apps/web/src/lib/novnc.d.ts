declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: object);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focus(): void;
    disconnect(): void;
  }
}
