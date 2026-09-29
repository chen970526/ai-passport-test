// 特斯拉 VCSEC 的 GATT 定义（16 bit 短号 0211 / 0212 / 0213 / 0214 + 128 位全形式）。
//
// 放在 infra/ble 而不是 protocol：这几个 UUID 是「蓝牙怎么连、往哪个特征写」的事实，
// 与报文内容无关；协议层（RoutableMessage / session_info）不该关心它们。
export const GATT = {
  service: '00000211-b2d1-43f0-9b88-960cebf8b91e',
  write: '00000212-b2d1-43f0-9b88-960cebf8b91e',
  indicate: '00000213-b2d1-43f0-9b88-960cebf8b91e',
  version: '00000214-b2d1-43f0-9b88-960cebf8b91e'
};

// 广播里出现的服务短号：0211 = 特斯拉 VCSEC。
// 车辆蓝牙名被系统缓存吃掉时，这是唯一还能认出「这是一台特斯拉」的线索。
export const TESLA_SERVICE_SHORT = '0211';
