/**
 * Ambient module declarations for dependencies that ship without TypeScript
 * types.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT).
 *
 * `@types/qrcode-terminal` may also be installed (and then supplies the named
 * exports); the declaration below only adds the CommonJS default-export shape
 * this code imports. TypeScript merges both module declarations.
 */
declare module 'qrcode-terminal' {
  interface QrcodeTerminalOptions {
    small?: boolean;
  }
  const qrcodeTerminal: {
    generate(
      text: string,
      options?: QrcodeTerminalOptions,
      callback?: (qrcode: string) => void,
    ): void;
  };
  export default qrcodeTerminal;
}
