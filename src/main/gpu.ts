/**
 * 硬件加速开关 —— 以及它和「透明窗口」的致命冲突。
 *
 * 背景
 * ----
 * 老显卡驱动、远程桌面、虚拟机里硬件加速有时会直接崩掉（GPU 进程退出），
 * 这时需要设 FLOATQUIZ_DISABLE_GPU=1 走软件渲染。
 *
 * ⚠️ 但关掉硬件加速之后，Windows 上 Chromium 无法合成透明通道：
 *   `transparent: true` 的窗口会被画成 **不透明的纯黑**。
 * 而浮窗是 `frame: false` + `skipTaskbar: true` + `alwaysOnTop('screen-saver')`，
 * 一旦变黑，用户看到的就是屏幕上多出一块**没有标题栏、任务栏里找不到、
 * 还盖在所有窗口之上**的黑色方块 —— 表现出来就跟整个屏幕黑了差不多。
 *
 * 结论
 * ----
 * 「关硬件加速」不能单独用。凡是关掉硬件加速的地方，窗口必须同步切成
 * 不透明模式（用 transparentOk() 判断），否则修 bug 的动作本身会造出更严重的 bug。
 *
 * 早先版本的 README 让人「浮窗一片黑就设 FLOATQUIZ_DISABLE_GPU=1」，
 * 方向正好是反的：那正是把浮窗变黑的原因。
 */

/** 是否已关闭硬件加速 */
export const GPU_DISABLED =
  process.env.FLOATQUIZ_DISABLE_GPU === '1' || process.argv.includes('--disable-gpu');

/** 当前环境能否使用透明窗口（透明依赖 GPU 合成） */
export function transparentOk(): boolean {
  return !GPU_DISABLED;
}
