// PaperWM — AX 通知名
//
// hs.ax 有两套名字，容易踩坑：
//
//   注册时用的是原始名：hs.ax.notificationTypes.windowCreated === "AXWindowCreated"
//   回调收到的却是短名：  notification === "windowCreated"
//
// 两者不一样。所以：
//   · 注册 → 用 RAW.*（原始名）
//   · 比较回调参数 → 用 SHORT.*（短名）
//
// 这个模块把两套名字放在一起，避免到处写错。

"use strict";

// 原始名（注册用）："AXWindowCreated"
const RAW = {
    windowCreated: "AXWindowCreated",
    windowMoved: "AXWindowMoved",
    windowResized: "AXWindowResized",
    windowMiniaturized: "AXWindowMiniaturized",
    windowDeminiaturized: "AXWindowDeminiaturized",
    focusedWindowChanged: "AXFocusedWindowChanged",
    mainWindowChanged: "AXMainWindowChanged",
    focusedUIElementChanged: "AXFocusedUIElementChanged",
    uIElementDestroyed: "AXUIElementDestroyed",
};

// 短名（回调里收到的）："windowCreated"
const SHORT = {
    windowCreated: "windowCreated",
    windowMoved: "windowMoved",
    windowResized: "windowResized",
    windowMiniaturized: "windowMiniaturized",
    windowDeminiaturized: "windowDeminiaturized",
    focusedWindowChanged: "focusedWindowChanged",
    mainWindowChanged: "mainWindowChanged",
    focusedUIElementChanged: "focusedUIElementChanged",
    uIElementDestroyed: "uIElementDestroyed",
};

/**
 * 把任意一种写法归一化成短名，方便比较。
 * @param {string} name "AXWindowCreated" 或 "windowCreated" 都行
 */
function shortName(name) {
    if (typeof name !== "string") return "";
    // 已经是短名
    if (!name.startsWith("AX")) return name;
    // 从 hs.ax.notificationTypes 反查：短名 → 原始名 → 短名
    for (const [short, raw] of Object.entries(hs.ax.notificationTypes)) {
        if (raw === name) return short;
    }
    return name;
}

module.exports = { RAW, SHORT, shortName };
