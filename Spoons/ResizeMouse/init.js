// ResizeMouse — Hammerspoon 2 Spoon
//
// 用鼠标修饰键直接操作窗口，不用去够窗口边缘：
//   ⌃⇧ 按住不放 + 移动鼠标 → 调整焦点窗口大小（等价于拖右下角）
//   ⌃⌥ 按住不放 + 移动鼠标 → 移动焦点窗口位置（等价于拖标题栏）
//
// 工作原理：
//   1. flagsChanged 检测到组合键 → 进入对应模式（resize / move）
//   2. 把鼠标"归位"到该模式的安全区内，保证各方向都有移动余量
//   3. 锁存焦点窗口、原始 frame、屏幕边界，并以"归位后的鼠标位置 +
//      窗口尺寸/位置"作为相对位移基准
//   4. 60Hz 定时器轮询鼠标坐标 → 按位移差算出新 frame → 写回窗口
//   5. 任一 modifier 松开 / ESC → 退出，保留新状态（ESC 回滚）
//
// 关键约束（这些是 v1 用大量踩坑换来的结论，移植时保留）：
//   · 归位点是推导出来的，不是随手选的：
//     · resize → 窗口右下角。被拖的就是这个角，光标落在角上；
//       上下左右四个方向的余量都等于窗口可缩放的幅度。
//     · move → 标题栏中点。窗口左上角只能在
//       [屏幕原点, 屏幕右下角 - 窗口尺寸] 之间移动，而光标停在标题栏
//       中点时，四个方向的余量恒 ≥ 窗口可移动幅度
//       （左/右需 winW/2 ≥ 0，下需 winH ≥ 14，皆恒成立），
//       因此任何可达位置都拖得到，不会出现"够不着"。
//   · 相对位移，不是绝对定位。归位后不改变窗口，只在鼠标真正移动后
//     按位移量调整，避免一按就跳到鼠标处。
//   · 二代里 win.frame = HSRect 赋值本身不带动画参数（v1 需要显式传
//     duration=0），所以拖拽不会滞后；AXEnhancedUserInterface 由
//     Hammerspoon 2 自动临时关闭，Chromium 系应用也不会再自己播动画。
//   · 用 60Hz 定时器轮询鼠标，不要用 mouseMoved eventtap：鼠标事件
//     一秒能来 100~200 次，每次都调 setFrame 会让 AX 调用排队积压，
//     窗口永远在追赶旧目标（表现为"不跟手"）。
//   · 全屏 / 最小化窗口跳过。
//   · resize 钳制：最小 100×100，最大不超过屏幕。
//   · move 钳制：窗口完整保持在屏幕可见区域内。
//
// 二代相对一代的改进：
//   · flagsChanged 的 tap 用 listen-only 模式。它永远不会吞事件，
//     也就不会挡住整条输入流——v1 用的是可修改 tap，只是每次都
//     返回 false 不吞，等于白白承担了阻塞输入的代价。
//   · ESC 的 tap 只在"正在操作窗口"期间存在，而不是像 v1 那样常驻。
//     常驻的 keyDown 可修改 tap 会在每一次按键时阻塞输入流。
//   · 进入/退出模式时的 AX 查询被推迟到下一个 runloop 迭代
//     （hs.timer.doAfter(0, ...)），不在 tap 回调里做跨进程查询。

"use strict";

// ---------------------------------------------------------------- 配置

const CONFIG = {
    minWidth: 100,
    minHeight: 100,
    // 光标在每个方向至少要留出的余量（px）。
    // 归位只在"某方向余量不足"时才发生，而且只推到刚好满足这个值，
    // 不再把光标从屏幕一头搬到窗口角上。
    warpMargin: 250,
    // 轮询频率：60Hz。每 tick 只读一次鼠标坐标（廉价 CG 调用），
    // 尺寸无变化时不触碰窗口，因此空闲时几乎零开销。
    pollInterval: 1 / 60,
    // 位移小于这个值（px）就不下发，避免无谓的 AX 调用。
    epsilon: 1,
};

// ---------------------------------------------------------------- 状态

const state = {
    ready: false,
    started: false,

    flagsTap: null,     // flagsChanged（listen-only）
    escTap: null,       // ESC（只在操作期间存在）
    pollTimer: null,    // 60Hz 轮询定时器

    active: false,      // 是否正在操作窗口
    mode: null,         // "resize" | "move"
    pending: null,      // 已触发但尚未进入的模式（延迟进入用）
    lastFlags: null,    // 最近一次 flagsChanged 的修饰键状态

    targetWin: null,    // 当前操作的窗口
    originalFrame: null,// 进入时的窗口 frame（用于 ESC 回滚）
    anchorX: 0,         // 进入时窗口左上角 X（resize 固定不动的角）
    anchorY: 0,         // 进入时窗口左上角 Y（resize 固定不动的角）
    startMouseX: 0,     // 进入瞬间的鼠标 X（相对位移基准）
    startMouseY: 0,     // 进入瞬间的鼠标 Y（相对位移基准）
    startW: 0,          // 进入瞬间的窗口宽（相对位移基准）
    startH: 0,          // 进入瞬间的窗口高（相对位移基准）
    startX: 0,          // 进入瞬间的窗口 X（move 基准）
    startY: 0,          // 进入瞬间的窗口 Y（move 基准）
    screenX: 0,         // 进入时锁存的屏幕左边界
    screenY: 0,         // 进入时锁存的屏幕上边界
    screenW: 0,         // 进入时锁存的屏幕宽
    screenH: 0,         // 进入时锁存的屏幕高
    maxRight: 0,        // 进入时锁存的屏幕右边界
    maxBottom: 0,       // 进入时锁存的屏幕下边界
    lastW: 0,           // 上次实际下发到窗口的宽（resize 去重）
    lastH: 0,           // 上次实际下发到窗口的高（resize 去重）
    lastX: 0,           // 上次实际下发到窗口的 X（move 去重）
    lastY: 0,           // 上次实际下发到窗口的 Y（move 去重）
};

// ---------------------------------------------------------------- 模式判定

/** 由修饰键状态推出应该进入哪个模式；不匹配返回 null */
function modeFromFlags(flags) {
    if (!flags) return null;
    const has = (name) => flags.includes(name);
    if (has("cmd")) return null;
    if (has("ctrl") && has("shift") && !has("alt")) return "resize";
    if (has("ctrl") && has("alt") && !has("shift")) return "move";
    return null;
}

// ---------------------------------------------------------------- 进入 / 退出

/** 找到要操作的窗口 */
function targetWindow() {
    const focused = hs.window.focusedWindow();
    if (focused) return focused;
    const app = hs.application.frontmost();
    return app ? app.focusedWindow : null;
}

function enter(mode) {
    if (state.active) return;

    // 所有可能失败的调用都放在 state.active = true 之前，
    // 否则中途抛错会留下 active=true 但定时器未启动的半死状态。
    const win = targetWindow();
    if (!win) {
        console.log("ResizeMouse: 没有可用的窗口");
        return;
    }

    const frame = win.frame;
    if (!frame) {
        console.log("ResizeMouse: 读不到窗口 frame");
        return;
    }

    if (!win.isStandard) {
        console.log("ResizeMouse: 窗口不是标准窗口");
        return;
    }

    if (win.isFullscreen) {
        console.log("ResizeMouse: 全屏窗口不支持此操作");
        return;
    }

    const screen = win.screen;
    if (!screen) {
        console.log("ResizeMouse: 找不到窗口所在屏幕");
        return;
    }
    const sf = screen.frame;
    const screenRight = sf.x + sf.w;
    const screenBottom = sf.y + sf.h;

    // 归位策略：按需轻推。
    // 归位要解决的是"光标贴边、往那个方向拖没空间"，而不是非得把光标搬到某处。
    //   · 光标在各方向的余量都 ≥ warpMargin → 完全不动它（绝大多数情况，零干扰）
    //   · 某一方向不足 → 只向内推到刚好满足余量，位移不会超过 warpMargin，
    //     不再从屏幕一头跳到窗口角上
    const cursor = hs.mouse.absolutePosition();
    const mgn = CONFIG.warpMargin;
    // 屏幕比 2×margin 还小时，退化为中心点
    let loX = sf.x + mgn;
    let hiX = screenRight - mgn;
    if (hiX < loX) { loX = sf.x + sf.w / 2; hiX = loX; }
    let loY = sf.y + mgn;
    let hiY = screenBottom - mgn;
    if (hiY < loY) { loY = sf.y + sf.h / 2; hiY = loY; }
    const warpX = Math.min(Math.max(cursor.x, loX), hiX);
    const warpY = Math.min(Math.max(cursor.y, loY), hiY);

    if (warpX !== cursor.x || warpY !== cursor.y) {
        try {
            hs.mouse.setAbsolutePosition(warpX, warpY);
        } catch (err) {
            console.error("ResizeMouse: 移动鼠标失败：" + err.message);
        }
    }

    state.originalFrame = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    state.anchorX = frame.x;
    state.anchorY = frame.y;
    state.screenX = sf.x;
    state.screenY = sf.y;
    state.screenW = sf.w;
    state.screenH = sf.h;
    state.maxRight = screenRight;
    state.maxBottom = screenBottom;
    state.lastW = frame.w;
    state.lastH = frame.h;
    state.lastX = frame.x;
    state.lastY = frame.y;
    // 相对位移基准：鼠标已归位，窗口保持不变。
    // 后续按位移差计算，鼠标没动时不会发出任何写操作，所以不跳变。
    state.startMouseX = warpX;
    state.startMouseY = warpY;
    state.startW = frame.w;
    state.startH = frame.h;
    state.startX = frame.x;
    state.startY = frame.y;
    state.targetWin = win;
    state.mode = mode;

    state.active = true;  // 全部就绪后才置位

    startPollTimer();
    startEscapeTap();

    console.log("ResizeMouse: 进入 " + mode + " 模式");
}

function startPollTimer() {
    stopPollTimer();
    state.pollTimer = hs.timer.doEvery(CONFIG.pollInterval, apply);
}

function stopPollTimer() {
    if (state.pollTimer) {
        state.pollTimer.stop();
        state.pollTimer = null;
    }
}

function startEscapeTap() {
    stopEscapeTap();
    const escapeCode = hs.keycodes.map.escape;
    // 只在操作期间存在：可修改的 keyDown tap 会在每次按键时挡住输入流，
    // 常驻它是没有必要的。
    state.escTap = hs.eventtap.addWatcher(
        [hs.eventtap.eventTypes.keyDown],
        (event) => {
            if (state.active && event.keyCode === escapeCode) {
                exit(true);  // 回滚
                return hs.eventtap.consume;
            }
            return hs.eventtap.emit;
        },
        false
    );
    if (state.escTap) state.escTap.start();
}

function stopEscapeTap() {
    if (state.escTap) {
        hs.eventtap.removeWatcher(state.escTap);
        state.escTap = null;
    }
}

function exit(restore) {
    if (!state.active) return;
    state.active = false;

    stopPollTimer();
    stopEscapeTap();

    if (restore && state.originalFrame && state.targetWin) {
        try {
            state.targetWin.frame = new HSRect(
                state.originalFrame.x, state.originalFrame.y,
                state.originalFrame.w, state.originalFrame.h);
        } catch (err) {
            console.error("ResizeMouse: 回滚窗口失败：" + err.message);
        }
    }

    state.targetWin = null;
    state.mode = null;
    state.originalFrame = null;
}

// ---------------------------------------------------------------- 每帧计算

/**
 * resize：把鼠标位移换算成窗口尺寸。
 * 左上角固定，右下角跟着鼠标走。
 */
function applyResize() {
    const win = state.targetWin;
    if (!win) return;

    // 相对位移：以按下瞬间为基准，鼠标移动多少，窗口右下角就跟着走多少。
    // 鼠标没动 → dx=dy=0 → 尺寸等于基准值 → 下面去重直接 return，
    // 因此按下那一刻不会产生任何跳变。
    const mouse = hs.mouse.absolutePosition();
    const dx = mouse.x - state.startMouseX;
    const dy = mouse.y - state.startMouseY;

    let newW = state.startW + dx;
    let newH = state.startH + dy;

    // 钳制：最小尺寸
    newW = Math.max(CONFIG.minWidth, newW);
    newH = Math.max(CONFIG.minHeight, newH);

    // 钳制：不能超出进入时锁存的屏幕范围（左上角固定，右下角不越界）
    newW = Math.min(newW, state.maxRight - state.anchorX);
    newH = Math.min(newH, state.maxBottom - state.anchorY);

    if (newW < CONFIG.minWidth || newH < CONFIG.minHeight) return;

    // 去重：与上次下发的尺寸几乎一致就跳过，避免无谓的 AX 调用
    if (Math.abs(newW - state.lastW) < CONFIG.epsilon &&
        Math.abs(newH - state.lastH) < CONFIG.epsilon) {
        return;
    }
    state.lastW = newW;
    state.lastH = newH;

    try {
        win.frame = new HSRect(state.anchorX, state.anchorY, newW, newH);
    } catch (err) {
        console.error("ResizeMouse: 设置窗口大小失败：" + err.message);
    }
}

/**
 * move：把鼠标位移直接当作窗口位移。
 * 与 resize 共用同一套基准与去重逻辑，只是作用在 x/y 而不是 w/h。
 * 钳制策略不同：move 保证窗口完整留在屏幕可见区域内，
 * 避免把窗口拖到完全看不见的地方。
 */
function applyMove() {
    const win = state.targetWin;
    if (!win) return;

    const mouse = hs.mouse.absolutePosition();
    const dx = mouse.x - state.startMouseX;
    const dy = mouse.y - state.startMouseY;

    let newX = state.startX + dx;
    let newY = state.startY + dy;

    // 钳制：窗口不允许超出屏幕可见区域
    const maxX = Math.max(state.screenX, state.screenX + state.screenW - state.startW);
    const maxY = Math.max(state.screenY, state.screenY + state.screenH - state.startH);
    newX = Math.min(Math.max(newX, state.screenX), maxX);
    newY = Math.min(Math.max(newY, state.screenY), maxY);

    // 去重：位置没变就不碰窗口
    if (Math.abs(newX - state.lastX) < CONFIG.epsilon &&
        Math.abs(newY - state.lastY) < CONFIG.epsilon) {
        return;
    }
    state.lastX = newX;
    state.lastY = newY;

    try {
        win.frame = new HSRect(newX, newY, state.startW, state.startH);
    } catch (err) {
        console.error("ResizeMouse: 移动窗口失败：" + err.message);
    }
}

function apply() {
    if (!state.active || !state.targetWin) return;
    if (state.mode === "move") applyMove();
    else applyResize();
}

// ---------------------------------------------------------------- 事件监听

function onFlagsChanged(event) {
    const flags = event.flags;
    state.lastFlags = flags;    // 记下最新状态，供延迟复核
    const mode = modeFromFlags(flags);

    if (mode && !state.active && !state.pending) {
        // 立刻让出回调，避免在 tap 里做跨进程 AX 查询。
        // 这段时间用户可能已松手或换了组合，所以下一步要复核。
        state.pending = mode;
        hs.timer.doAfter(0, () => {
            const m = state.pending;
            state.pending = null;
            if (!m) return;
            // 复核：这一瞬间用户可能已松手或换了组合
            if (modeFromFlags(state.lastFlags) !== m) return;
            if (state.active) return;
            enter(m);
        });
    } else if (!mode && state.active) {
        exit(false);  // 保留当前状态（此路径无 AX 调用，不阻塞）
    } else if (mode && state.active && mode !== state.mode) {
        // 中途换了组合键（少见）：先收尾再按新模式进入
        exit(false);
        enter(mode);
    }

    return hs.eventtap.emit;  // flagsChanged 永远不吞
}

function startFlagsTap() {
    stopFlagsTap();
    // listen-only：永远不吞事件，也就不会挡住输入流。
    state.flagsTap = hs.eventtap.addWatcher(
        [hs.eventtap.eventTypes.flagsChanged],
        onFlagsChanged,
        true
    );
    if (state.flagsTap) state.flagsTap.start();
}

function stopFlagsTap() {
    if (state.flagsTap) {
        hs.eventtap.removeWatcher(state.flagsTap);
        state.flagsTap = null;
    }
}

// ---------------------------------------------------------------- 生命周期

function start() {
    module.exports.init();
    if (state.started) return module.exports;
    state.started = true;

    startFlagsTap();
    console.log("ResizeMouse: 已启动（⌃⇧ 调整大小 · ⌃⌥ 移动窗口）");
    return module.exports;
}

function stop() {
    exit(true);  // 退出并回滚（如果正在操作）
    state.pending = null;
    state.lastFlags = null;
    stopFlagsTap();
    state.started = false;
    console.log("ResizeMouse: 已停止");
    return module.exports;
}

// ---------------------------------------------------------------- 导出

module.exports = {
    name: "ResizeMouse",
    version: "2.0.0",
    author: "djx",
    description: "用鼠标修饰键直接操作窗口：⌃⇧ 调整大小 · ⌃⌥ 移动窗口",

    // init() 在每次 hs.spoons.load() 时都会被调用，必须幂等。
    init() {
        if (state.ready) return;
        state.ready = true;
    },

    start,
    stop,

    isActive() { return state.active; },
    currentMode() { return state.mode; },
    config: CONFIG,
};
