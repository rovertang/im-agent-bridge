/**
 * Weixin (WeChat iLink bot) channel — public surface.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT) for the
 * protocol layer (`protocol/`); the credential store, port adapter and
 * transport are bridge-native, written against this repo's channel port
 * contract (`src/channel/port.ts`) and profile state layout.
 *
 * Typical wiring:
 *   loginWeixinAccount(...) → saveWeixinAccount(...) → startWeixinTransport(...)
 * or, for one-shot sends, `createWeixinChannelPort(account)`.
 */
export {
  DEFAULT_WEIXIN_BASE_URL,
  WEIXIN_ILINK_APP_ID,
  WEIXIN_ILINK_APP_CLIENT_VERSION,
  WEIXIN_CHANNEL_VERSION,
  WEIXIN_TOKEN_EXPIRED_CODE,
  WeixinApiError,
  buildWeixinBaseInfo,
  getBotQrcode,
  getConfig,
  getJson,
  getQrcodeStatus,
  getUpdates,
  notifyStart,
  notifyStop,
  parseWeixinJson,
  postJson,
  sendMessage,
  sendTyping,
  type WeixinApiOptions,
  type WeixinRequest,
} from './protocol/api';
export {
  DEFAULT_ILINK_BOT_TYPE,
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
  type BaseInfo,
  type CDNMedia,
  type FileItem,
  type GetBotQrcodeResp,
  type GetConfigResp,
  type GetQrcodeStatusResp,
  type GetUpdatesReq,
  type GetUpdatesResp,
  type ImageItem,
  type MessageItem,
  type NotifyStartResp,
  type NotifyStopResp,
  type RefMessage,
  type SendMessageReq,
  type SendMessageResp,
  type SendTypingReq,
  type TextItem,
  type WeixinMessage,
  type WeixinQrStatus,
} from './protocol/types';
export {
  loginWeixinAccount,
  WeixinAlreadyConnectedError,
  WeixinLoginError,
  type WeixinLoginOptions,
  type WeixinLoginResult,
  type WeixinQrInfo,
} from './protocol/login';
export {
  clearWeixinAccount,
  hasWeixinAccount,
  listWeixinAccounts,
  loadWeixinAccount,
  safeWeixinAccountId,
  saveWeixinAccount,
  weixinAccountPath,
  weixinAccountsDir,
  weixinStateDir,
  type WeixinAccount,
} from './credentials';
export {
  createOutboundThrottle,
  createWeixinChannelPort,
  markdownToPlainText,
  newWeixinClientId,
  splitWeixinText,
  WEIXIN_CAPABILITIES,
  WEIXIN_MAX_TEXT_LENGTH,
  WEIXIN_MIN_SEND_INTERVAL_MS,
  type WeixinChannelPort,
  type WeixinOutboundThrottle,
  type WeixinTypingHandle,
} from './port';
export {
  WEIXIN_QUOTE_LIMIT,
  WeixinQuoteStore,
  weixinQuoteBucketKey,
  weixinQuoteStorePath,
  type WeixinQuoteEntry,
  type WeixinQuoteKind,
  type WeixinQuoteStoreOptions,
} from './quotes';
export {
  startWeixinTransport,
  WeixinTokenExpiredError,
  type WeixinInboundMessage,
  type WeixinTransport,
  type WeixinTransportOptions,
  type WeixinTransportStatus,
} from './transport';
export {
  WEIXIN_SYNC_SEEN_LIMIT,
  loadWeixinSync,
  rememberWeixinMessageId,
  saveWeixinSync,
  weixinSyncPath,
  type WeixinSyncState,
} from './sync-store';
