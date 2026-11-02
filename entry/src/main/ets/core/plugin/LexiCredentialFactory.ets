// 身份凭据铸造工厂（RFC §3.4）。
// 所有宿主侧身份凭据（插件令牌 / 页面会话凭据 / 桥侧令牌）都必须经这里铸造：
// 系统密码学安全随机数（cryptoFramework），256bit 熵，不含任何可猜测的时间戳或序号。
// 禁止伪随机数（Math 对象的 random）与时间戳参与凭据铸造（plugin-bridge-security.cjs R2 门禁钉死）。

import { cryptoFramework } from '@kit.CryptoArchitectureKit';

/** 32 字节（256bit）系统安全随机数的十六进制串，64 字符。 */
export function secureRandomHex(byteLength: number): string {
  const rand = cryptoFramework.createRandom();
  const blob = rand.generateRandomSync(byteLength);
  const bytes = new Uint8Array(blob.data);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const piece = bytes[i].toString(16);
    hex += piece.length === 1 ? '0' + piece : piece;
  }
  return hex;
}

/** 铸造一条身份凭据：前缀仅用于日志对账（尾部 6 位即可对账，见 LexiWebRuntime.tokenTail）。 */
export function mintCredential(prefix: string): string {
  return prefix + '-' + secureRandomHex(32);
}
