// P1-003d(R28)·装载轨决策单一真源。
//
// RFC §3.6:「安全 PoC 测试通过不等于业务运行时已经安全;最终必须在真实业务加载路径中验证」。
// 旧共享 realm 轨(runtime 页 `new Function` 共享求值面,ADR-R25-01 过渡通道)在沙箱轨
// 真机验收(P1-003d)完成前保留为默认,但必须成为显式可停用的开关:
//   - lexiPluginLegacyTrack = 'true'(默认,本轮定案):legacy 轨可用,行为与 R27 前逐字节一致;
//   - lexiPluginLegacyTrack = 'false':旧共享 realm 路径 fail-closed——任何未声明沙箱轨
//     (或沙箱容器不可达)的插件一律拒绝装载(errorState + markFailed,不派发、不静默回落)。
// 决策是纯函数:门禁(plugin-dist-regression)转译本模块即可对开关两种朝向做行为级断言,
// enablePlugin 只做接线,不内联第二份判定。
//
// 本模块必须零依赖(与 LexiPluginManifestV2 同纪律)。

/** 沙箱轨(per-plugin opaque-origin iframe,bootPlugin 端口链)。 */
export const TRACK_SANDBOX: string = 'sandbox';
/** 旧共享 realm 轨(runtime 页 shim load.plugin,过渡保留)。 */
export const TRACK_LEGACY: string = 'legacy';
/** fail-closed:拒绝装载,不得派发任何执行面。 */
export const TRACK_REFUSED: string = 'refused';

/**
 * 装载轨决策(纯函数,无 IO)。
 *
 * @param sandboxService 清单是否声明沙箱轨入口(entrypoints.service='sandbox:')。
 * @param sandboxTrackOn 沙箱轨是否可用(容器页已挂载,或 lexiPluginSandboxTrack 运行开关为 true)。
 * @param legacyTrackSetting lexiPluginLegacyTrack 落盘值('true'/'false';空值=默认 'true')。
 * @returns TRACK_SANDBOX | TRACK_LEGACY | TRACK_REFUSED。
 */
export function resolvePluginTrack(sandboxService: boolean, sandboxTrackOn: boolean,
  legacyTrackSetting: string): string {
  const legacyAllowed = legacyTrackSetting !== 'false';
  if (sandboxService && sandboxTrackOn) { return TRACK_SANDBOX; }
  // 沙箱轨不可达(未声明或容器未就绪)时,唯一出路是 legacy 轨——开关关死即拒绝。
  // 沙箱声明插件在开关关死时同样不得溜进共享 realm(R28 前的"默认回落旧轨"废除为
  // "开关开着才回落")。
  return legacyAllowed ? TRACK_LEGACY : TRACK_REFUSED;
}
