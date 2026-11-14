/** Browser media adapter for Codex's native voice. Account tokens never enter this module. */
export class NativeVoice {
  private readonly controller = new AbortController();
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private disconnected: ReturnType<typeof setTimeout> | null = null;
  private readonly delegations = new Set<string>();
  private muted = false;

  constructor(
    private readonly hooks: {
      connect: (offer: string, signal: AbortSignal) => Promise<string>;
      ready: () => void;
      transcript: (role: "user" | "bot", text: string) => void;
      delegate: (id: string, text: string) => Promise<void>;
      error: (message: string) => void;
    },
  ) {}

  async start() {
    const signal = this.controller.signal;
    this.handshake = setTimeout(
      () => this.fail("Voice connection timed out. Hang up and try again."),
      45_000,
    );
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (signal.aborted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .catch(() =>
            this.fail("Audio playback was blocked. Allow audio for this site and try again."),
          );
      };
      pc.onconnectionstatechange = () => {
        if (signal.aborted) return;
        if (this.disconnected) clearTimeout(this.disconnected);
        this.disconnected = null;
        if (pc.connectionState === "failed" || pc.connectionState === "closed")
          this.fail("Voice connection closed. Hang up and try again.");
        else if (pc.connectionState === "disconnected")
          this.disconnected = setTimeout(
            () => this.fail("Voice connection was lost. Hang up and try again."),
            10_000,
          );
      };
      for (const track of stream.getAudioTracks()) {
        track.enabled = !this.muted;
        pc.addTrack(track, stream);
      }
      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (event) => this.receive(event.data);
      channel.onclose = () => {
        if (!signal.aborted) this.fail("Voice connection closed. Hang up and try again.");
      };
      await pc.setLocalDescription(await pc.createOffer());
      if (signal.aborted) return;
      const offer = pc.localDescription?.sdp;
      if (!offer) throw new Error("Could not prepare the microphone connection.");
      const answer = await this.hooks.connect(offer, signal);
      if (!signal.aborted) await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      if (!signal.aborted)
        this.fail(error instanceof Error ? error.message : "Voice connection failed.");
    }
  }

  mute(muted: boolean) {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  reply(id: string, text: string) {
    if (this.channel?.readyState !== "open" || this.controller.signal.aborted) return;
    // Native Codex bounds each context append to 500 UTF-8 bytes.
    let chunk = "";
    const send = () =>
      this.channel?.send(
        JSON.stringify({
          type: "delegation.context.append",
          delegation_item_id: id,
          channel: "speakable",
          content: [{ type: "input_text", text: chunk }],
        }),
      );
    for (const char of text.slice(0, 16_000)) {
      if (new TextEncoder().encode(chunk + char).byteLength > 500) {
        send();
        chunk = "";
      }
      chunk += char;
    }
    if (chunk) send();
  }

  close() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    if (this.handshake) clearTimeout(this.handshake);
    if (this.disconnected) clearTimeout(this.disconnected);
    this.channel?.close();
    this.pc?.close();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.audio?.pause();
    if (this.audio) this.audio.srcObject = null;
    this.delegations.clear();
  }

  private fail(message: string) {
    this.close();
    this.hooks.error(message);
  }

  private receive(raw: unknown) {
    if (this.controller.signal.aborted || typeof raw !== "string" || raw.length > 1_000_000) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || !("type" in value)) return;
    if (value.type === "session.started") {
      if (this.handshake) clearTimeout(this.handshake);
      this.handshake = null;
      this.hooks.ready();
    }
    if (
      value.type === "turn.done" &&
      "turn" in value &&
      value.turn &&
      typeof value.turn === "object"
    ) {
      const turn = value.turn;
      if (
        "role" in turn &&
        "transcript" in turn &&
        typeof turn.transcript === "string" &&
        (turn.role === "user" || turn.role === "assistant")
      )
        this.hooks.transcript(
          turn.role === "user" ? "user" : "bot",
          turn.transcript.slice(0, 16_000),
        );
    }
    if (value.type === "error")
      this.fail("The voice service reported an error. Hang up and try again.");
    if (
      value.type !== "delegation.created" ||
      !("item" in value) ||
      !value.item ||
      typeof value.item !== "object"
    )
      return;
    const item = value.item;
    if (
      !("type" in item) ||
      item.type !== "delegation" ||
      !("target" in item) ||
      item.target !== "client" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("content" in item) ||
      !Array.isArray(item.content)
    )
      return;
    if (this.delegations.has(item.id)) return;
    if (this.delegations.size >= 100) {
      this.fail("This call has reached its task limit. Start another call to continue.");
      return;
    }
    const text = item.content
      .flatMap((part: unknown) =>
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "input_text" &&
        "text" in part &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("")
      .slice(0, 16_000);
    if (!text.trim()) return;
    this.delegations.add(item.id);
    const id = item.id;
    void this.hooks
      .delegate(id, text)
      .catch(() =>
        this.reply(
          id,
          "The request could not reach Pi. Report the connection error; do not claim completion or retry automatically.",
        ),
      );
  }
}
