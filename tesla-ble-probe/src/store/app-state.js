// 探针的全局会话状态：密钥、V3 会话（按 domain 各一份）、BLE 实例、日志总线。
//
// 这个对象是全站唯一的单例，页面拿到的 `state` 必须是同一个引用：
// 页面里既有 state.vin 这种读，也有 state.v3 = {} / state.ble = null 这种整体赋值，
// 所以字段一律保持普通可写属性，不许换成 getter。

export const state = {
  vin: '',
  privateKey: null, // Uint8Array(32)
  publicKey: null, // Uint8Array(65)
  keyId: '', // hex(40) = SHA1(公钥)
  v3: {}, // 按 domain 索引的 V3 会话，见 v3Session(domain)
  ble: null
};

export default state;
