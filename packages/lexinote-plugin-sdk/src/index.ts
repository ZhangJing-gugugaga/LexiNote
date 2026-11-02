// RFC §10.1 · LexiNote 插件 SDK 入口。
// 开发者使用 SDK 类型与契约常量;运行时实现全部由宿主提供(require('obsidian') 命名空间)。
export { API_VERSION, SDK_METHODS, methodsOf } from './contract';
export type { SdkMethodEntry } from './contract';
export { capabilityTags, normalizeCapabilityHost } from './capabilities';
export type { CapabilityDeclaration } from './capabilities';
