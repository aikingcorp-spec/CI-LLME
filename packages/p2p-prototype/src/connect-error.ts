export type P2PConnectErrorCode = "ice_failed" | "no_candidate_pair" | "timeout";

export interface P2PConnectMessage {
  vi: string;
  en: string;
}

const NOT_REACHED: P2PConnectMessage = {
  vi: "Không kết nối được tới máy của bạn. Kiểm tra máy đang bật, hoặc thử mạng khác (4G hoặc wifi nhà).",
  en: "Could not connect to your computer. Check that it is turned on, or try another network (4G or home wifi).",
};

const MESSAGES: Record<P2PConnectErrorCode, P2PConnectMessage> = {
  // Both sides had candidates and the connectivity checks still failed: a network in the way.
  ice_failed: {
    vi: "Mạng của bạn đang chặn kết nối trực tiếp, hãy thử mạng khác (4G hoặc wifi nhà).",
    en: "Your network is blocking direct connections, try another network (4G or home wifi).",
  },
  no_candidate_pair: NOT_REACHED,
  timeout: NOT_REACHED,
};

/** The text to show for a code. The code itself is for logs, not for the person. */
export function p2pConnectMessage(code: P2PConnectErrorCode): P2PConnectMessage {
  return MESSAGES[code];
}

/** A data channel could not be established to the node. Safe to show `userMessage` to the person. */
export class P2PConnectError extends Error {
  /** Vietnamese. */
  readonly userMessage: string;
  readonly userMessageEn: string;
  constructor(
    readonly code: P2PConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "P2PConnectError";
    this.userMessage = MESSAGES[code].vi;
    this.userMessageEn = MESSAGES[code].en;
  }
}
