export type P2PConnectErrorCode = "ice_failed" | "no_candidate_pair" | "timeout";

/** A data channel could not be established to the node. Safe to show `userMessage` to the person. */
export class P2PConnectError extends Error {
  readonly userMessage =
    "Mạng của bạn đang chặn kết nối trực tiếp, hãy thử mạng khác (4G hoặc wifi nhà).";
  constructor(
    readonly code: P2PConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "P2PConnectError";
  }
}
