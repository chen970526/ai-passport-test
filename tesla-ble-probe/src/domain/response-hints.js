// 响应与故障 → 人话提示文案（只放文案，不改判读逻辑）。

import { FAULT } from '../protocol/index.js';
import { RKE } from './v3-context.js';
import { ble } from './connection-service.js';

// 官方 RKEAction_E 只剩这五个值，页面上的自定义 action 超范围时先提个醒
export const KNOWN_RKE = [
  RKE.RKE_ACTION_UNLOCK,
  RKE.RKE_ACTION_LOCK,
  RKE.RKE_ACTION_REMOTE_DRIVE,
  RKE.RKE_ACTION_AUTO_SECURE_VEHICLE,
  RKE.RKE_ACTION_WAKE_VEHICLE
];

// 刷卡配对的操作提示。官方 security.go:314 的注释要求两步：
// 「tapping their NFC card on the center console」+「confirming their intent on the vehicle UI」
//
// 关键：这里的 NFC card 指的是 Tesla 随车发的**实体钥匙卡 / 钥匙遥控器**，不是手机。
// 车端读卡区只是 RFID 读卡器，不做 HCE 卡 emulation；三星 / 小米的 NFC 贴上去
// 只会触发起手机自己的 NFC 探测弹窗，车辆侧什么都收不到。官方 Tesla App 配对手机
// 时同样要求刷实体钥匙卡（车主手册：钥匙卡用于「authenticate 手机」）。
export const TAP_HINT =
  '必须用 Tesla 实体钥匙卡（或钥匙遥控器），手机 NFC 贴读卡区无效——车端只读 RFID 卡，不做手机卡模拟。' +
  '读卡区（官方说明）：Model 3/Y = 中控台杯架后方；Model S/X/Cybertruck = 左侧无线充电板顶部往下刷。' +
  '刷卡后还要在车机屏幕点「确认」，官方文档要求两步齐全才会落库';

// 白名单操作回执 → 人话。只列配对场景真会遇到的码，其余走枚举名原文
export const PAIR_HINTS = {
  0: '已加入白名单，可以回去试「查白名单」和开锁了',
  3: '钥匙卡槽位已满，先移除一把不用的实体钥匙',
  4: '白名单已满，先移除一把不用的钥匙',
  5: '当前这把钥匙没有加钥匙的权限，需要用车主钥匙刷卡',
  12: '用来签署这条请求的钥匙本身不在白名单里',
  13: '本机公钥已经在白名单里了，直接试开锁即可',
  14: '车辆要求先检测到钥匙卡在读卡区才允许添加：先把卡放上去再重按绑定',
  23: '车机没能起本地授权流程，重新踩刹车唤醒车机再试',
  24: '车机屏幕上点了「拒绝」',
  25: '等刷卡超时：卡没贴 / 贴的位置不对 / 贴太晚',
  26: '刷了卡但没在车机屏幕上点确认，超时了',
  27: '车辆处于代客模式，不允许加钥匙',
  28: '车机屏幕上取消了配对'
};

// 协议层 fault → 下一步该干什么。只列本项目真会撞上的两个 MTU 码
// （权威口径：universal_message.proto:56-57 —— 24 = 客户端请求体超 MTU，
//   25 = 「请求车收到了，但响应体超过 MTU」；error.go:195-198 官方把这两个码归入
//   MayHaveSucceeded：车已经收下请求，只是答案装不进这一包，命令本身可能已经生效）。
// 其余 fault 走枚举名原文，别猜。
export const FAULT_HINT = {
  [FAULT.MESSAGEFAULT_ERROR_REQUEST_MTU_EXCEEDED]: '请求体比协商的 MTU 还大，车辆压根没解析它：本项目已经做到一条 vehicleAction 一包、车辆信息每类一问，再撞上就看日志里 MTU 协商到了多少',
  [FAULT.MESSAGEFAULT_ERROR_RESPONSE_MTU_EXCEEDED]: '答案太大、这一包装不下，所以车辆直接不发数据：车辆信息已经按「每类一条」拆开发问，单类仍超包说明这一类本身就装不进当前 MTU，只能把 MTU 谈高（见日志 MTU 行）或少问这一类'
};

// 车端 nominalError（GenericError_E）→ 下一步该干什么。
//
// 只列本项目发 RKE 动作真会撞上的码，其余走枚举名原文，别猜。
// 出处：ref-repos/vehicle-command pkg/protocol/protobuf/errors.proto:8-18 +
//       pkg/vehicle/vcsec.go:173-193（executeRKEAction 把 nominalError 原样上抛）。
//
// 按**枚举名**而不是数值索引：sendRequest 的失败分支只回 { ok, text, fault }，不带 obj，
// 能匹配的就是 appOutcome 渲染出来的 label('GenericError_E', …)，
// 形如 GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT(7)。
// 匹配发生在 command-dispatcher.js 的 genericErrorHint()：解锁 / 上锁 / 驾驶授权任何一条
// 被车端这样拒绝，都会带上对应的下一步。
export const GENERIC_ERROR_HINTS = {
  GENERICERROR_CLOSURES_OPEN:
    '有门 / 前备箱 / 后备箱没关严，车辆拒绝这个动作：先让所有开度归零再按（车主手册里「锁不上先检查门有没有关好」就是这个）',
  GENERICERROR_ALREADY_ON:
    '车辆已经处于上电 / 驾驶授权状态：RemoteDrive 是「让车可以开走」的开关，重复请求会被这里挡下。' +
      '反过来说，锁车撞上这个码通常是车还没从授权状态里退出来——先下车、挂 P、再锁；' +
      '手机钥匙留在车内时车辆也会故意拒绝上锁（防止把手机锁在车里），这不是链路故障',
  GENERICERROR_DISABLED_FOR_USER_COMMAND:
    '这条命令被车机里的用户开关关了：去车机「安全」/「手机 App 车控」一类设置里确认它没被禁用',
  GENERICERROR_VEHICLE_NOT_IN_PARK:
    '车辆不在 P 挡：RemoteDrive 只给停稳挂 P 的车做驾驶授权，先把它停回 P 再按',
  GENERICERROR_UNAUTHORIZED:
    '这把钥匙的权限不够（官方 protocol.md:187-198：能授权哪些命令由角色决定）。本项目按 ROLE_DRIVER 加白，仍被拒说明这台车对驾驶授权要求更高级别的钥匙（例如车主钥匙）',
  GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT:
    '车端明确不允许这条命令走当前 transport（官方 errors.proto:17 GENERICERROR_NOT_ALLOWED_OVER_TRANSPORT）。' +
      '注意这不是 SDK 的限制：官方把同一个 RemoteDrive() 同时挂在 BLE CLI（commands.go:311 "drive"）和 Fleet 命令（proxy/command.go:207 "remote_start_drive"）上，' +
      '是这台车的策略只放其中一条。BLE 侧无解，改走 Wi-Fi/Internet + Tesla Fleet API 的 remote_start_drive 完成驾驶授权'
};

// 当前协商到的 MTU，只用来把提示写得更具体；拿不到就算了，绝不因此影响判读
export function mtuNote() {
  try {
    const b = ble();
    return b && b.mtu ? '（当前 MTU=' + b.mtu + '）' : '';
  } catch (e) {
    return '';
  }
}
