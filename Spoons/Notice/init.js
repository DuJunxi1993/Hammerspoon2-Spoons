// Notice — Hammerspoon 2 Spoon
//
// 轻量级深色短提示。
//
// 面板全部用 Hammerspoon 2 的原生浮层（hs.ui.alert），不再自己拼 SwiftUI：
//   · 原生外观：hs.ui.alert 用的是系统的 glass 材质（Liquid Glass），
//     自动适配浅色/深色模式，不需要自己挑背景色。
//   · 不抢焦点：默认的"叠放"式提示只是 orderFront，不会 makeKey，
//     用户正在敲字不会被打断。
//   · 自动堆叠：多条提示会依次往下排，不会互相盖住。
//
// 三种锚点：
//   "center" —— 屏幕居中（默认，叠放显示）
//   "cursor" —— 鼠标指针右下
//   "window" —— 聚焦窗口右上角内侧
//
// "cursor" / "window" 需要指定位置，hs.ui.alert 会为它单独开一个全屏窗口并
// makeKey（抢焦点），所以显示之后要把焦点还给用户原来在用的应用。
//
// 用法：
//   const notice = hs.spoons.load("Notice");
//   notice.show("已复制到剪贴板");
//   notice.show("EN · ABC", "输入法已切换", 0.9, "center");

"use strict";

// ---------------------------------------------------------------- 配置

const CONFIG = {
    defaultDuration: 1.4,    // 秒
    maxTitleLength: 60,      // 超过则截断为「前 N-1 字 + …」
    fontSize: 12,
    fontWeight: "medium",
    padding: 14,             // 气泡内边距
    cursorOffsetX: 48,       // 气泡中心相对鼠标的偏移（气泡大小未知，只能估）
    cursorOffsetY: 34,
    windowOffsetX: 70,       // 气泡中心相对聚焦窗口右上角的偏移
    windowOffsetY: 26,
};

// ---------------------------------------------------------------- 状态

const state = {
    ready: false,
    alert: null,
};

// ---------------------------------------------------------------- 坐标工具
//
// hs.ui.alert 的 position 是「相对所在屏幕可见区域左上角、y 向下」，
// 而 hs.screen / hs.mouse 用的是 Hammerspoon 全局坐标（主屏左上角，y 向下）。
// 两者差一个屏幕偏移。

/** Hammerspoon 全局坐标 → hs.ui.alert 的 position 坐标 */
function toAlertSpace(x, y) {
    const main = hs.screen.main();
    if (!main) return { x: x, y: y };
    const f = main.frame;
    return { x: x - f.x, y: y - f.y };
}

function cursorPosition() {
    const pos = hs.mouse.absolutePosition();
    return toAlertSpace(pos.x + CONFIG.cursorOffsetX, pos.y + CONFIG.cursorOffsetY);
}

/** 聚焦窗口右上角内侧。窗口不在了就把位置给回 null（退回居中）。 */
function windowPosition(win) {
    if (!win || !win.frame) return null;
    const f = win.frame;
    return toAlertSpace(f.x + f.w - CONFIG.windowOffsetX, f.y + CONFIG.windowOffsetY);
}

function truncateTitle(text) {
    const s = text == null ? "" : String(text);
    if (s.length <= CONFIG.maxTitleLength) return s;
    return s.slice(0, CONFIG.maxTitleLength - 1) + "…";
}

// ---------------------------------------------------------------- 生命周期

function hide() {
    if (state.alert) {
        try {
            state.alert.close();
        } catch (err) {
            console.error("Notice.hide(): " + err.message);
        }
        state.alert = null;
    }
}

/**
 * 显示一条提示。
 * @param {string} title 标题
 * @param {string=} subtitle 副标题（可选）
 * @param {number=} duration 显示时长（秒），默认 1.4
 * @param {"center"|"cursor"|"window"=} anchor 锚点，默认 "center"
 */
function show(title, subtitle, duration, anchor) {
    hide();

    const safeTitle = truncateTitle(title);
    const sub = subtitle == null ? "" : String(subtitle);
    const message = sub ? safeTitle + "\n" + sub : safeTitle;

    const seconds = typeof duration === "number" ? duration : CONFIG.defaultDuration;
    const alert = hs.ui.alert(message)
        .font(HSFont.system(CONFIG.fontSize, CONFIG.fontWeight))
        .padding(CONFIG.padding)
        .duration(seconds);

    const mode = anchor || "center";
    if (mode === "cursor" || mode === "window") {
        // 定位型提示会 makeKey，把焦点抢走；记下当前应用，弹完再请回来。
        const previousApp = hs.application.frontmost();
        const position = mode === "cursor" ? cursorPosition() : windowPosition(hs.window.focusedWindow());

        if (position) {
            alert.position(position);
        }
        alert.show();

        if (position && previousApp && previousApp.isActive === false) {
            try {
                previousApp.activate(false);
            } catch (err) {
                // 还原失败不是致命问题，忽略即可
            }
        }
    } else {
        // 默认：叠放式。居中显示，不抢焦点，多条提示自动往下排。
        alert.show();
    }

    state.alert = alert;
    return module.exports;
}

// ---------------------------------------------------------------- 导出
//
// init() 在每次 hs.spoons.load() 时都会被调用（require 只求值一次），
// 所以这里必须做成幂等的：只准备状态，不启停任何东西。

module.exports = {
    name: "Notice",
    version: "2.1.0",
    author: "djx",
    description: "轻量级深色短提示",

    init() {
        if (state.ready) return;
        state.ready = true;
    },

    start() {
        module.exports.init();
        return module.exports;
    },

    stop() {
        hide();
        return module.exports;
    },

    show,
    hide,
    truncateTitle,
};
