import { ItemView, Notice, Plugin, WorkspaceLeaf, setIcon } from "obsidian";

const VIEW_TYPE = "apple-pencil-capability-probe";
const MAX_EVENT_RECORDS = 10_000;
const UPDATE_INTERVAL_MS = 100;

type ProbeMode = "free" | "pressure" | "tilt" | "speed" | "hover" | "palm" | "pencil-pro";

interface Capability {
  id: string;
  label: string;
  supported: boolean;
  observed: boolean;
  detail: string;
}

interface EventRecord {
  type: string;
  time: number;
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
  x?: number;
  y?: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  twist?: number;
  tangentialPressure?: number;
  width?: number;
  height?: number;
  buttons?: number;
  button?: number;
  coalescedCount: number;
  predictedCount: number;
  touchCount?: number;
}

interface PerformanceSummary {
  pointerEvents: number;
  pointerRawUpdates: number;
  inputFrequencyHz: number;
  meanIntervalMs: number;
  maxIntervalMs: number;
  coalescedPointsPerEvent: number;
  predictedPointsPerEvent: number;
  renderLatencyMs: number;
  frames: number;
  droppedFrames: number;
  droppedFramePercent: number;
}

interface ProbeReport {
  format: "apple-pencil-capability-probe";
  version: 1;
  generatedAt: string;
  mode: ProbeMode;
  capabilities: Capability[];
  performance: PerformanceSummary;
  eventCount: number;
  touchEventCount: number;
  recordsTruncated: boolean;
  events: EventRecord[];
  touchEvents: Array<{ type: string; time: number; touches: number; changedTouches: number }>;
  environment: Record<string, unknown>;
}

const MODE_LABELS: Record<ProbeMode, string> = {
  free: "Free writing",
  pressure: "Pressure test",
  tilt: "Tilt test",
  speed: "Speed test",
  hover: "Hover test",
  palm: "Palm test",
  "pencil-pro": "Pencil Pro test"
};

const MODE_HINTS: Record<ProbeMode, string> = {
  free: "Write anywhere in the pad. Every supported pointer and touch event is captured.",
  pressure: "Draw slowly from a light touch to a firm touch. Watch pressure continuity.",
  tilt: "Draw while changing the Pencil angle. Compare tilt, altitude and azimuth values.",
  speed: "Draw once slowly and once quickly. Compare sample intervals and coalesced points.",
  hover: "Move the Pencil above the display without touching. Record when hover events begin.",
  palm: "Write with the Pencil while resting your palm on the display. Inspect touch records.",
  "pencil-pro": "Try barrel roll, squeeze and double tap. Hardware gestures may not surface in Web APIs."
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rounded(value: number | undefined, digits = 3): number | undefined {
  return value === undefined ? undefined : Number(value.toFixed(digits));
}

function ownKeys(value: unknown): string[] {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
  return Object.getOwnPropertyNames(value).sort();
}

function prototypeKeys(value: unknown): string[] {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
  const keys = new Set<string>();
  let current: object | null = value as object;
  while (current && current !== Object.prototype) {
    Object.getOwnPropertyNames(current).forEach((key) => keys.add(key));
    current = Object.getPrototypeOf(current) as object | null;
  }
  return Array.from(keys).sort();
}

function scanCapabilities(): Capability[] {
  const pointerProto = typeof PointerEvent !== "undefined" ? PointerEvent.prototype : undefined;
  const touchProto = typeof TouchEvent !== "undefined" ? TouchEvent.prototype : undefined;
  const hasPointer = Boolean(pointerProto);
  const hasProperty = (name: string) => hasPointer && name in (pointerProto as object);
  const hasMethod = (name: string) => hasPointer && typeof (pointerProto as unknown as Record<string, unknown>)[name] === "function";
  return [
    { id: "pointerType", label: "Pointer type", supported: hasProperty("pointerType"), observed: false, detail: "pen / touch / mouse" },
    { id: "pressure", label: "Pressure", supported: hasProperty("pressure"), observed: false, detail: "0..1" },
    { id: "tilt", label: "Tilt X/Y", supported: hasProperty("tiltX") && hasProperty("tiltY"), observed: false, detail: "degrees" },
    { id: "altitude", label: "Altitude angle", supported: hasProperty("altitudeAngle"), observed: false, detail: "radians" },
    { id: "azimuth", label: "Azimuth angle", supported: hasProperty("azimuthAngle"), observed: false, detail: "radians" },
    { id: "twist", label: "Barrel roll", supported: hasProperty("twist"), observed: false, detail: "degrees" },
    { id: "tangential", label: "Tangential pressure", supported: hasProperty("tangentialPressure"), observed: false, detail: "-1..1" },
    { id: "size", label: "Contact size", supported: hasProperty("width") && hasProperty("height"), observed: false, detail: "CSS pixels" },
    { id: "raw", label: "Raw updates", supported: "onpointerrawupdate" in window, observed: false, detail: "pointerrawupdate" },
    { id: "coalesced", label: "Coalesced events", supported: hasMethod("getCoalescedEvents"), observed: false, detail: "getCoalescedEvents()" },
    { id: "predicted", label: "Predicted events", supported: hasMethod("getPredictedEvents"), observed: false, detail: "getPredictedEvents()" },
    { id: "hover", label: "Hover", supported: "onpointerenter" in window, observed: false, detail: "pointerenter / leave" },
    { id: "touch", label: "Touch events", supported: Boolean(touchProto), observed: false, detail: "TouchEvent" },
    { id: "squeeze", label: "Pencil Pro squeeze", supported: false, observed: false, detail: "No standard Web signal" },
    { id: "double-tap", label: "Pencil double tap", supported: false, observed: false, detail: "No standard Web signal" }
  ];
}

function formatValue(value: number | string | undefined, suffix = ""): string {
  if (value === undefined || value === "") return "-";
  return `${typeof value === "number" ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : value}${suffix}`;
}

class ProbeView extends ItemView {
  private rootEl?: HTMLElement;
  private stage?: HTMLCanvasElement;
  private context?: CanvasRenderingContext2D;
  private liveValues = new Map<string, HTMLElement>();
  private capabilityValues = new Map<string, HTMLElement>();
  private eventLogEl?: HTMLPreElement;
  private metricsEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private modeHintEl?: HTMLElement;
  private mode: ProbeMode = "free";
  private capabilities = scanCapabilities();
  private events: EventRecord[] = [];
  private touchEvents: Array<{ type: string; time: number; touches: number; changedTouches: number }> = [];
  private recordsTruncated = false;
  private lastPointerTime?: number;
  private firstMoveTime?: number;
  private intervalTotal = 0;
  private intervalCount = 0;
  private maxInterval = 0;
  private coalescedTotal = 0;
  private predictedTotal = 0;
  private lastInputAt?: number;
  private renderLatencyTotal = 0;
  private renderLatencyCount = 0;
  private pointerEvents = 0;
  private pointerRawUpdates = 0;
  private frames = 0;
  private droppedFrames = 0;
  private lastFrameAt?: number;
  private updateTimer?: number;
  private animationFrame?: number;
  private lastPoint?: { x: number; y: number };

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Apple Pencil Capability Probe"; }
  getIcon(): string { return "pencil"; }

  async onOpen(): Promise<void> {
    this.rootEl = this.contentEl.createDiv({ cls: "apple-pencil-probe" });
    this.renderLayout(this.rootEl);
    this.installListeners();
    this.startRenderLoop();
    this.updateTimer = window.setInterval(() => this.refreshSummary(), UPDATE_INTERVAL_MS);
    this.refreshSummary();
  }

  async onClose(): Promise<void> {
    if (this.updateTimer !== undefined) window.clearInterval(this.updateTimer);
    if (this.animationFrame !== undefined) window.cancelAnimationFrame(this.animationFrame);
    this.updateTimer = undefined;
    this.animationFrame = undefined;
    this.stage = undefined;
    this.context = undefined;
    this.rootEl = undefined;
    this.modeHintEl = undefined;
  }

  private renderLayout(root: HTMLElement): void {
    const header = root.createDiv({ cls: "probe-header" });
    const title = header.createDiv({ cls: "probe-title" });
    title.createEl("h1", { text: "Apple Pencil Capability Probe" });
    title.createDiv({ cls: "probe-subtitle", text: "WebView and WebKit input capability test" });

    const toolbar = header.createDiv({ cls: "probe-toolbar" });
    const modeLabel = toolbar.createEl("label", { cls: "probe-mode-label", text: "Mode" });
    const modeSelect = toolbar.createEl("select", { cls: "probe-mode-select" });
    modeSelect.setAttribute("aria-label", "Test mode");
    (Object.keys(MODE_LABELS) as ProbeMode[]).forEach((mode) => {
      modeSelect.createEl("option", { value: mode, text: MODE_LABELS[mode] });
    });
    modeLabel.appendChild(modeSelect);
    modeSelect.addEventListener("change", () => {
      this.mode = modeSelect.value as ProbeMode;
      if (this.modeHintEl) this.modeHintEl.setText(MODE_HINTS[this.mode]);
      this.refreshSummary();
    });
    const clearButton = toolbar.createEl("button", { cls: "probe-button", attr: { type: "button" } });
    setIcon(clearButton, "trash-2");
    clearButton.createSpan({ text: "Clear" });
    clearButton.addEventListener("click", () => this.clearRecords());
    const exportButton = toolbar.createEl("button", { cls: "probe-button mod-cta", attr: { type: "button" } });
    setIcon(exportButton, "download");
    exportButton.createSpan({ text: "Export JSON" });
    exportButton.addEventListener("click", () => this.exportReport());

    this.modeHintEl = root.createDiv({ cls: "probe-mode-hint", text: MODE_HINTS[this.mode] });

    const grid = root.createDiv({ cls: "probe-grid" });
    const livePanel = grid.createDiv({ cls: "probe-panel" });
    livePanel.createEl("h2", { text: "Live input" });
    const liveGrid = livePanel.createDiv({ cls: "probe-value-grid" });
    [
      ["pointerType", "Pointer type"], ["pressure", "Pressure"], ["tiltX", "Tilt X"], ["tiltY", "Tilt Y"],
      ["altitudeAngle", "Altitude angle"], ["azimuthAngle", "Azimuth angle"], ["twist", "Twist"],
      ["tangentialPressure", "Tangential pressure"], ["width", "Width"], ["height", "Height"],
      ["buttons", "Buttons"], ["button", "Button"], ["coalescedCount", "Coalesced"], ["predictedCount", "Predicted"]
    ].forEach(([id, label]) => {
      const item = liveGrid.createDiv({ cls: "probe-value" });
      item.createDiv({ cls: "probe-value-label", text: label });
      this.liveValues.set(id, item.createDiv({ cls: "probe-value-number", text: "-" }));
    });

    const capabilityPanel = grid.createDiv({ cls: "probe-panel" });
    capabilityPanel.createEl("h2", { text: "Capability matrix" });
    const capabilityGrid = capabilityPanel.createDiv({ cls: "probe-capability-grid" });
    this.capabilities.forEach((capability) => {
      const row = capabilityGrid.createDiv({ cls: "probe-capability" });
      row.createDiv({ cls: "probe-capability-label", text: capability.label });
      const value = row.createDiv({ cls: "probe-capability-state" });
      this.capabilityValues.set(capability.id, value);
      row.createDiv({ cls: "probe-capability-detail", text: capability.detail });
    });

    const stagePanel = root.createDiv({ cls: "probe-panel probe-stage-panel" });
    const stageHeading = stagePanel.createDiv({ cls: "probe-stage-heading" });
    stageHeading.createEl("h2", { text: "Writing and hover area" });
    this.statusEl = stageHeading.createDiv({ cls: "probe-status", text: "Waiting for input" });
    this.stage = stagePanel.createEl("canvas", { cls: "probe-stage" });
    this.stage.setAttribute("aria-label", "Apple Pencil test area");
    this.context = this.stage.getContext("2d") ?? undefined;
    this.resizeCanvas();
    root.createDiv({ cls: "probe-stage-hint", text: "Use Apple Pencil or touch in this area." });

    const metricsPanel = root.createDiv({ cls: "probe-panel" });
    metricsPanel.createEl("h2", { text: "Performance" });
    this.metricsEl = metricsPanel.createDiv({ cls: "probe-metrics", text: "-" });

    const logPanel = root.createDiv({ cls: "probe-panel probe-log-panel" });
    const details = logPanel.createEl("details", { attr: { open: "" } });
    details.createEl("summary", { text: "Raw event log" });
    this.eventLogEl = details.createEl("pre", { cls: "probe-log" });
    this.eventLogEl.setText("No events captured yet.");

    this.registerDomEvent(window, "resize", () => this.resizeCanvas());
  }

  private installListeners(): void {
    if (!this.stage) return;
    const pointerTypes: Array<keyof HTMLElementEventMap> = ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerenter", "pointerleave", "pointerrawupdate" as keyof HTMLElementEventMap];
    pointerTypes.forEach((type) => {
      this.registerDomEvent(this.stage as HTMLElement, type, (event: Event) => this.handlePointerEvent(event as PointerEvent));
    });
    const touchTypes: Array<keyof HTMLElementEventMap> = ["touchstart", "touchmove", "touchend", "touchcancel"];
    touchTypes.forEach((type) => {
      this.registerDomEvent(this.stage as HTMLElement, type, (event: Event) => this.handleTouchEvent(event as TouchEvent), { passive: false });
    });
  }

  private handlePointerEvent(event: PointerEvent): void {
    if (event.cancelable) event.preventDefault();
    const time = finiteNumber(event.timeStamp) ?? performance.now();
    const coalesced = this.readEventList(event, "getCoalescedEvents");
    const predicted = this.readEventList(event, "getPredictedEvents");
    const record: EventRecord = {
      type: event.type,
      time: rounded(time, 2) ?? 0,
      pointerId: finiteNumber(event.pointerId),
      pointerType: event.pointerType || undefined,
      isPrimary: event.isPrimary,
      x: rounded(finiteNumber(event.clientX), 2),
      y: rounded(finiteNumber(event.clientY), 2),
      pressure: rounded(finiteNumber(event.pressure)),
      tiltX: rounded(finiteNumber(event.tiltX), 2),
      tiltY: rounded(finiteNumber(event.tiltY), 2),
      altitudeAngle: rounded(finiteNumber(event.altitudeAngle)),
      azimuthAngle: rounded(finiteNumber(event.azimuthAngle)),
      twist: rounded(finiteNumber(event.twist), 2),
      tangentialPressure: rounded(finiteNumber(event.tangentialPressure)),
      width: rounded(finiteNumber(event.width), 2),
      height: rounded(finiteNumber(event.height), 2),
      buttons: finiteNumber(event.buttons),
      button: finiteNumber(event.button),
      coalescedCount: coalesced.length,
      predictedCount: predicted.length
    };
    this.appendRecord(record);
    this.pointerEvents += 1;
    if (event.type === "pointerrawupdate") this.pointerRawUpdates += 1;
    if (event.type === "pointermove" || event.type === "pointerrawupdate") {
      if (this.firstMoveTime === undefined) this.firstMoveTime = time;
      if (this.lastPointerTime !== undefined) {
        const interval = Math.max(0, time - this.lastPointerTime);
        this.intervalTotal += interval;
        this.intervalCount += 1;
        this.maxInterval = Math.max(this.maxInterval, interval);
      }
      this.lastPointerTime = time;
      this.coalescedTotal += coalesced.length;
      this.predictedTotal += predicted.length;
    }
    this.lastInputAt = performance.now();
    this.updateObservedCapabilities(record, event.type);
    this.updateLiveValues(record);
    this.drawPointer(record, coalesced);
    if (event.type === "pointerenter" && event.pointerType === "pen") this.markCapability("hover");
    this.statusEl?.setText(`${event.type} received`);
  }

  private handleTouchEvent(event: TouchEvent): void {
    if (event.cancelable) event.preventDefault();
    const item = { type: event.type, time: rounded(finiteNumber(event.timeStamp) ?? performance.now(), 2) ?? 0, touches: event.touches.length, changedTouches: event.changedTouches.length };
    this.touchEvents.push(item);
    if (this.touchEvents.length > MAX_EVENT_RECORDS) this.touchEvents.shift();
    this.markCapability("touch");
    if (this.mode === "palm" && event.touches.length > 0) this.statusEl?.setText(`${event.type}: ${event.touches.length} touch contact(s)`);
  }

  private readEventList(event: PointerEvent, method: "getCoalescedEvents" | "getPredictedEvents"): PointerEvent[] {
    const candidate = event as PointerEvent & { [key: string]: unknown };
    try {
      const fn = candidate[method];
      return typeof fn === "function" ? (fn as () => PointerEvent[]).call(event) || [] : [];
    } catch {
      return [];
    }
  }

  private appendRecord(record: EventRecord): void {
    this.events.push(record);
    if (this.events.length > MAX_EVENT_RECORDS) {
      this.events.shift();
      this.recordsTruncated = true;
    }
  }

  private updateObservedCapabilities(record: EventRecord, eventType: string): void {
    if (record.pointerType) this.markCapability("pointerType");
    ["pressure", "tiltX", "tiltY", "altitudeAngle", "azimuthAngle", "twist", "tangentialPressure", "width", "height"].forEach((field) => {
      if (record[field as keyof EventRecord] !== undefined) {
        const id = field === "tiltX" || field === "tiltY" ? "tilt" : field === "altitudeAngle" ? "altitude" : field === "azimuthAngle" ? "azimuth" : field === "tangentialPressure" ? "tangential" : field;
        this.markCapability(id);
      }
    });
    if (eventType === "pointerrawupdate") this.markCapability("raw");
    if (record.coalescedCount > 0) this.markCapability("coalesced");
    if (record.predictedCount > 0) this.markCapability("predicted");
    if (eventType === "pointerenter" || eventType === "pointerleave") this.markCapability("hover");
  }

  private markCapability(id: string): void {
    const capability = this.capabilities.find((item) => item.id === id);
    if (!capability) return;
    capability.observed = true;
    const element = this.capabilityValues.get(id);
    if (element) {
      element.setText(capability.supported ? "YES" : "OBSERVED");
      element.className = `probe-capability-state ${capability.supported ? "is-supported" : "is-observed"}`;
    }
  }

  private updateLiveValues(record: EventRecord): void {
    const values = record as unknown as Record<string, number | string | undefined>;
    this.liveValues.forEach((element, id) => {
      const value = values[id];
      element.setText(id === "pointerType" ? (value as string | undefined) ?? "-" : formatValue(value as number | undefined));
    });
  }

  private drawPointer(record: EventRecord, coalesced: PointerEvent[]): void {
    if (!this.stage || !this.context || record.x === undefined || record.y === undefined) return;
    const bounds = this.stage.getBoundingClientRect();
    const point = { x: record.x - bounds.left, y: record.y - bounds.top };
    this.context.save();
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    this.context.strokeStyle = record.pointerType === "pen" ? "#3b82f6" : "#f59e0b";
    this.context.lineWidth = Math.max(1.5, (record.pressure ?? 0.5) * 7);
    if (this.lastPoint && (record.type === "pointermove" || record.type === "pointerrawupdate")) {
      this.context.beginPath();
      this.context.moveTo(this.lastPoint.x, this.lastPoint.y);
      this.context.lineTo(point.x, point.y);
      this.context.stroke();
    } else if (record.type === "pointerdown") {
      this.context.beginPath();
      this.context.arc(point.x, point.y, this.context.lineWidth / 2, 0, Math.PI * 2);
      this.context.fillStyle = this.context.strokeStyle;
      this.context.fill();
    }
    this.context.restore();
    if (record.type === "pointerup" || record.type === "pointercancel" || record.type === "pointerleave") this.lastPoint = undefined;
    else this.lastPoint = point;
  }

  private resizeCanvas(): void {
    if (!this.stage || !this.context) return;
    const rect = this.stage.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    this.stage.width = Math.max(1, Math.floor(rect.width * ratio));
    this.stage.height = Math.max(1, Math.floor(rect.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.lastPoint = undefined;
  }

  private startRenderLoop(): void {
    const frame = (now: number) => {
      this.frames += 1;
      if (this.lastFrameAt !== undefined) {
        const delta = now - this.lastFrameAt;
        if (delta > 25) this.droppedFrames += Math.max(1, Math.round(delta / (1000 / 60)) - 1);
      }
      this.lastFrameAt = now;
      if (this.lastInputAt !== undefined) {
        this.renderLatencyTotal += Math.max(0, now - this.lastInputAt);
        this.renderLatencyCount += 1;
        this.lastInputAt = undefined;
      }
      this.animationFrame = window.requestAnimationFrame(frame);
    };
    this.animationFrame = window.requestAnimationFrame(frame);
  }

  private getPerformanceSummary(): PerformanceSummary {
    const duration = this.firstMoveTime !== undefined && this.lastPointerTime !== undefined ? this.lastPointerTime - this.firstMoveTime : 0;
    const meanInterval = this.intervalCount ? this.intervalTotal / this.intervalCount : 0;
    const inputFrequencyHz = duration > 0 ? (this.intervalCount * 1000) / duration : 0;
    const frameDenominator = this.frames + this.droppedFrames;
    return {
      pointerEvents: this.pointerEvents,
      pointerRawUpdates: this.pointerRawUpdates,
      inputFrequencyHz,
      meanIntervalMs: meanInterval,
      maxIntervalMs: this.maxInterval,
      coalescedPointsPerEvent: this.intervalCount ? this.coalescedTotal / this.intervalCount : 0,
      predictedPointsPerEvent: this.intervalCount ? this.predictedTotal / this.intervalCount : 0,
      renderLatencyMs: this.renderLatencyCount ? this.renderLatencyTotal / this.renderLatencyCount : 0,
      frames: this.frames,
      droppedFrames: this.droppedFrames,
      droppedFramePercent: frameDenominator ? (this.droppedFrames / frameDenominator) * 100 : 0
    };
  }

  private refreshSummary(): void {
    const metrics = this.getPerformanceSummary();
    this.metricsEl?.setText([
      `Input frequency: ${metrics.inputFrequencyHz.toFixed(1)} Hz`,
      `Mean interval: ${metrics.meanIntervalMs.toFixed(2)} ms`,
      `Max interval: ${metrics.maxIntervalMs.toFixed(2)} ms`,
      `Coalesced points: ${metrics.coalescedPointsPerEvent.toFixed(2)} / event`,
      `Predicted points: ${metrics.predictedPointsPerEvent.toFixed(2)} / event`,
      `Render latency: ${metrics.renderLatencyMs.toFixed(2)} ms`,
      `Dropped frames: ${metrics.droppedFramePercent.toFixed(2)}% (${metrics.droppedFrames})`,
      `Pointer events: ${metrics.pointerEvents} | Touch events: ${this.touchEvents.length}`
    ].join("\n"));
    this.capabilities.forEach((capability) => {
      const element = this.capabilityValues.get(capability.id);
      if (!element || capability.observed) return;
      element.setText(capability.supported ? "READY" : "NO");
      element.className = `probe-capability-state ${capability.supported ? "is-ready" : "is-unavailable"}`;
    });
    if (this.eventLogEl) {
      const recent = this.events.slice(-80).map((event) => JSON.stringify(event)).join("\n");
      this.eventLogEl.setText(recent || "No events captured yet.");
    }
  }

  private clearRecords(): void {
    this.events = [];
    this.touchEvents = [];
    this.recordsTruncated = false;
    this.lastPointerTime = undefined;
    this.firstMoveTime = undefined;
    this.intervalTotal = 0;
    this.intervalCount = 0;
    this.maxInterval = 0;
    this.coalescedTotal = 0;
    this.predictedTotal = 0;
    this.pointerEvents = 0;
    this.pointerRawUpdates = 0;
    this.lastPoint = undefined;
    this.context?.clearRect(0, 0, this.stage?.width ?? 0, this.stage?.height ?? 0);
    this.statusEl?.setText("Log cleared");
    this.refreshSummary();
  }

  private exportReport(): void {
    const report: ProbeReport = {
      format: "apple-pencil-capability-probe",
      version: 1,
      generatedAt: new Date().toISOString(),
      mode: this.mode,
      capabilities: this.capabilities,
      performance: this.getPerformanceSummary(),
      eventCount: this.events.length,
      touchEventCount: this.touchEvents.length,
      recordsTruncated: this.recordsTruncated,
      events: this.events,
      touchEvents: this.touchEvents,
      environment: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
        pointerEventPrototype: ownKeys(typeof PointerEvent !== "undefined" ? PointerEvent.prototype : undefined),
        touchEventPrototype: ownKeys(typeof TouchEvent !== "undefined" ? TouchEvent.prototype : undefined),
        windowWebkit: ownKeys((window as Window & { webkit?: unknown }).webkit),
        windowCapacitor: ownKeys((window as Window & { Capacitor?: unknown }).Capacitor),
        navigatorKeys: prototypeKeys(navigator)
      }
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `apple-pencil-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    new Notice(`Exported ${report.eventCount} pointer events and ${report.touchEventCount} touch events.`);
  }
}

export default class ApplePencilProbePlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new ProbeView(leaf));
    this.addRibbonIcon("pencil", "Open Apple Pencil capability probe", () => this.activateView());
    this.addCommand({
      id: "open-apple-pencil-capability-probe",
      name: "Open Apple Pencil capability probe",
      callback: () => this.activateView()
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
