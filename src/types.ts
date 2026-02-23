import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk";

export type { DmPolicy, GroupPolicy };

export type WeChatPadProAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this WeChatPadPro account. Default: true. */
  enabled?: boolean;
  /** Server URL (e.g., "http://120.48.170.187:8061"). */
  serverUrl?: string;
  /** WeChat ID (wxid) after login. */
  wxid?: string;
  /** Direct message policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist of user IDs allowed to DM the bot. */
  allowFrom?: string[];
  /** Optional allowlist for group senders (wxid). */
  groupAllowFrom?: string[];
  /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by wxid. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Media upload max size in MB. */
  mediaMaxMb?: number;
  /** Auth code for API authentication (replaces direct wxid for API auth). Required for ws861 backend. */
  authcode?: string;
  /** Port for receiving webhook callbacks. Default derived from gateway. */
  webhookPort?: number;
  /** Keywords that trigger bot in groups. */
  triggerKeywords?: string[];
  /** Group chatroom IDs where trigger keywords work for anyone. */
  openGroups?: string[];
  /** Automatically grab red packets. */
  autoGrabRedPacket?: boolean;
  /** Voice ASR (speech-to-text) config. */
  voiceAsr?: {
    baiduApiKey: string;
    baiduSecretKey: string;
  };
  /** Nicknames that trigger when @'d in groups. */
  myNicknames?: string[];
  /** Blocked account IDs. */
  blockedAccounts?: string[];
  /** Suffix added to AI replies. Default: " [AI]" */
  aiSuffix?: string;
  /** Rate limiting. */
  rateLimiting?: {
    chatCooldownMs?: number;
    globalMaxPerMin?: number;
  };
  /** Startup buffer in milliseconds. */
  startupBufferMs?: number;
}

export type WeChatPadProConfig = {
  /** Base URL for webhook callback (default: OPENCLAW_GATEWAY_URL or http://127.0.0.1:19001). */
  webhookBaseUrl?: string;
  /** Optional per-account WeChatPadPro configuration (multi-account). */
  accounts?: Record<string, WeChatPadProAccountConfig>;
} & WeChatPadProAccountConfig;

export type CoreConfig = {
  channels?: {
    wechatpadpro?: WeChatPadProConfig;
  };
  [key: string]: unknown;
};

/** Result from sending a message to WeChatPadPro. */
export type WeChatPadProSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/** Parsed incoming message context. */
export type WeChatPadProInboundMessage = {
  messageId: string;
  wxid: string;
  senderWxid: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isGroupChat: boolean;
  groupWxid?: string;
  groupName?: string;
  /** WeChat message type (1=text, 49=app, 51=sync, etc.) */
  msgType?: number;
  /** Raw content before parsing (for type 49 XML) */
  rawContent?: string;
};

/** Options for sending a message. */
export type WeChatPadProSendOptions = {
  serverUrl: string;
  wxid: string;
  toWxid: string;
  content: string;
  type?: number; // 1 = text, other types for @ mentions, etc.
  at?: string; // For group @ mentions, comma-separated wxids
};
