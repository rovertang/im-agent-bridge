/**
 * Weixin iLink protocol types (JSON wire format over HTTP).
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT).
 * Only the subset this bridge currently needs is kept; upstream also carries
 * upload/media-item types that the media pipeline will need later.
 *
 * Wire notes (verified against the live service in Step 0):
 *  - `uint64` fields (`message_id`, `msg_id`, `svr_id`, `seq`) arrive as raw
 *    JSON numbers and MUST be quoted before `JSON.parse` or they lose
 *    precision — see `parseWeixinJson` in `api.ts`. They are typed as
 *    `string` here for that reason.
 *  - `bytes` fields are base64 strings in JSON.
 */

/** Common request metadata attached to every CGI request. */
export interface BaseInfo {
  /** Client build that produced the request. */
  channel_version?: string;
  /** UA-style self-declared bot identity; observability only. */
  bot_agent?: string;
}

/** proto: WeixinMessage.message_type. */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** proto: MessageItem.type. */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** proto: WeixinMessage.message_state. */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

/** proto: TypingStatus — 1 = typing, 2 = cancel typing. */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

/** Default `bot_type` for the login QR endpoints (this channel build). */
export const DEFAULT_ILINK_BOT_TYPE = '3';

export interface TextItem {
  text?: string;
}

/** CDN media reference; `aes_key` is base64-encoded bytes in JSON. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0 = only the file id is encrypted, 1 = thumbnail/mid-image bundle. */
  encrypt_type?: number;
  /** Full download URL returned by the server (no client-side assembly needed). */
  full_url?: string;
}

/**
 * Inbound image item.
 *
 * TODO(media): decrypt `media.full_url` with AES-128-ECB using the raw hex
 * `aeskey` (32 chars), then hand the bytes to the media pipeline.
 */
export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as a hex string (16 bytes); preferred for inbound decrypt. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  /** Plaintext size, serialised as a string on the wire. */
  len?: string;
}

/** Quoted/replied-to message reference. */
export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
  /** Server message id used when newer clients omit the quoted content. */
  svr_id?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  file_item?: FileItem;
}

/** Unified message (proto: WeixinMessage). */
export interface WeixinMessage {
  /** uint64 on the wire; parsed losslessly as a string. */
  seq?: string;
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

/** `ilink/bot/getupdates` request. */
export interface GetUpdatesReq {
  /** Full context buf cached locally; send `""` when none. */
  get_updates_buf?: string;
}

/** `ilink/bot/getupdates` response (long-poll). */
export interface GetUpdatesResp {
  ret?: number;
  /** Server error code (e.g. -14 = token/session expired). */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** Context buf to cache and send on the next request. */
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next long-poll. */
  longpolling_timeout_ms?: number;
}

/** `ilink/bot/sendmessage` request: wraps a single message. */
export interface SendMessageReq {
  msg?: WeixinMessage;
}

/** `ilink/bot/sendmessage` response. Empty body (HTTP 200) means success. */
export interface SendMessageResp {
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** `ilink/bot/sendtyping` request. */
export interface SendTypingReq {
  /** The user the typing indicator is shown to. */
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 1 = typing (default), 2 = cancel typing. */
  status?: number;
}

export interface SendTypingResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** `ilink/bot/getconfig` response: bot config, includes the typing ticket. */
export interface GetConfigResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  /** Base64 typing ticket for `sendtyping`. */
  typing_ticket?: string;
}

export interface NotifyStartResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface NotifyStopResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** `ilink/bot/get_bot_qrcode` response. */
export interface GetBotQrcodeResp {
  /** Opaque QR handle polled against `get_qrcode_status`. */
  qrcode: string;
  /** Content to encode into the QR (usually a URL the user scans). */
  qrcode_img_content: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Login QR state reported by `ilink/bot/get_qrcode_status`. */
export type WeixinQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

/** `ilink/bot/get_qrcode_status` response. */
export interface GetQrcodeStatusResp {
  status: WeixinQrStatus;
  /** Issued on `confirmed`; bot token for subsequent API calls. */
  bot_token?: string;
  /** Issued on `confirmed`; the bot account id (`…@im.bot`). */
  ilink_bot_id?: string;
  /** Issued on `confirmed`; the API base URL assigned to this bot. */
  baseurl?: string;
  /** The WeChat user id of the person who scanned. */
  ilink_user_id?: string;
  /** New polling host when status is `scaned_but_redirect`. */
  redirect_host?: string;
}
