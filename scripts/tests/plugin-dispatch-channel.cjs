'use strict';
// P1-006b①:dispatch 通道鉴权的门禁侧镜像。
//
// 生产实现在两处:.ets 协议面 LexiWebRuntime.mintChannelCredential/admitDispatch
// (一次性通道凭据,单次核销,method+payload 双绑定),以及 shim 的 __receive 门卫
// (回调执行前必须先经 lexiHost.admitDispatch 核销成功,裸调/重放/换绑定 fail-closed)。
// 离线门禁的宿主桩(vm/JSDOM)原本只桩 lexiHost.call —— 协议升级后派发帧多了第 3 实参,
// 本模块给各门禁宿主提供同语义的"铸造+核销"对,使合法派发链路走通;负例
// (无凭据/伪凭据/重放/换方法换载荷)在各门禁里据此钉死。
//
// 只服务测试壳;不得被任何生产代码引用(生产凭据只能经 mintCredential CSPRNG 铸造)。

function createDispatchChannel() {
  const pending = new Map();
  let seq = 0;
  return {
    /** 镜像 LexiWebRuntime.mintChannelCredential:铸造一次性通道凭据并登记绑定。 */
    mint(method, payloadJson) {
      seq += 1;
      const credential = 'dc-gate-' + seq;
      pending.set(credential, String(method) + '\u0000' + String(payloadJson));
      return credential;
    },
    /**
     * 镜像 LexiWebRuntime.admitDispatch:单次有效(首条核销申请即烧毁),
     * method+payload 绑定不符一律 false。
     */
    admitDispatch(credential, method, payloadJson) {
      const bound = (typeof credential === 'string') ? pending.get(credential) : undefined;
      if (bound === undefined) { return false; }
      pending.delete(credential);
      const sep = bound.indexOf('\u0000');
      return sep >= 0 && bound.slice(0, sep) === String(method) &&
        bound.slice(sep + 1) === String(payloadJson);
    },
    pendingCount() { return pending.size; }
  };
}

module.exports = { createDispatchChannel };
