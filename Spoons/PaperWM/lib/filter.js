// PaperWM — 窗口过滤
//
// v1 靠 hs.window.filter 的原生过滤器：
//   setOverrideFilter({ visible = true, fullscreen = false,
//                        hasTitlebar = true, allowRoles = "AXStandardWindow" })
// 再叠加 setAppFilter("Safari", { rejectTitles = {...} }) 这类应用级规则。
//
// 二代没有 hs.window.filter 子模块（HS2 的 hs.window 只有全部/可见/
// 按应用/按屏幕/按坐标这几个取窗口的方法），所以过滤是一个普通函数。
//
// 规则存��数组，匹配用正则。规则形如：
//   { rejectTitles: ["^画中画$"] }          标题匹配的窗口被排除
//   { rejectAll: true }                    这个应用的所有窗口都排除
//   { rejectBundleIDs: ["com.foo.bar"] }   排除这个 Bundle ID 的窗口

"use strict";

const { config, defaultRules, defaultBundleRules } = require("./config");

// 应用显示名（小写） -> 规则数组
const appRules = new Map();
// Bundle ID（小写） -> 规则数组
const bundleRules = new Map();
// 允许平铺的显示器（空 = 全部都允许）
let allowedScreens = null;

/**
 * 限制只平铺某些显示器上的窗口。
 *
 * v1 的 window_filter:setScreens({ "Built%-in Retina Display" })
 * 用的是 Lua 模式匹配显示器名。这里用普通的字符串匹配，
 * 传 null / 空数组表示恢复"全部都平铺"。
 */
function setScreens(names) {
    if (!names || (Array.isArray(names) && names.length === 0)) {
        allowedScreens = null;
        return;
    }
    allowedScreens = (Array.isArray(names) ? names : [names])
        .map((name) => String(name).toLowerCase());
}

/** 当前允许平铺的显示器列表（null = 全部） */
function getScreens() {
    return allowedScreens;
}

function compilePattern(pattern) {
    if (pattern instanceof RegExp) return pattern;
    const text = String(pattern);
    // "/foo/i" 这种写法直接当正则；其它当作普通字符串，
    // 但仍然支持 ^ $ 通配（和 v1 的 Lua 模式一致）
    if (text.length > 1 && text.startsWith("/") && text.lastIndexOf("/") > 0) {
        const lastSlash = text.lastIndexOf("/");
        const body = text.slice(1, lastSlash);
        const flags = text.slice(lastSlash + 1);
        try {
            return new RegExp(body, flags);
        } catch (err) {
            return new RegExp(escapeForRegExp(text));
        }
    }
    return new RegExp(text);
}

function escapeForRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 覆盖某个应用的规则 */
function setAppFilter(appName, rules) {
    if (!appName) return;
    const key = String(appName).toLowerCase();
    if (!rules) {
        appRules.delete(key);
        return;
    }
    const list = [];
    for (const pattern of rules.rejectTitles || []) {
        list.push({ type: "title", pattern: compilePattern(pattern) });
    }
    for (const bundleID of rules.rejectBundleIDs || []) {
        list.push({ type: "bundle", value: String(bundleID).toLowerCase() });
    }
    if (rules.rejectAll) list.push({ type: "all" });
    appRules.set(key, list);
}

/** 排除某个 Bundle ID 的全部窗口 */
function setBundleFilter(bundleID, reject) {
    if (!bundleID) return;
    const key = String(bundleID).toLowerCase();
    if (reject === false) {
        bundleRules.delete(key);
        return;
    }
    bundleRules.set(key, [{ type: "all" }]);
}

/**
 * 排除某个应用的全部窗口（v1 的 window_filter:rejectApp）。
 */
function rejectApp(appName) {
    if (!appName) return;
    setAppFilter(appName, { rejectAll: true });
}

function resetRules() {
    appRules.clear();
    bundleRules.clear();
    loadDefaults();
}

function loadDefaults() {
    for (const [name, rules] of Object.entries(defaultRules)) {
        setAppFilter(name, rules);
    }
    for (const bundleID of Object.keys(defaultBundleRules)) {
        setBundleFilter(bundleID, true);
    }
}

/** 窗口是否应该被平铺 */
function isAllowed(win) {
    if (!win) return false;

    // 基础过滤（对应 v1 的 setOverrideFilter）
    if (win.isMinimized) return false;     // visible = true
    if (win.isFullscreen) return false;    // fullscreen = false
    if (!win.isStandard) return false;     // hasTitlebar + allowRoles = AXStandardWindow

    const app = win.application;
    if (!app) return false;

    // 有些应用明明能平铺，却报告"不可最大化"。
    // config.allowNonMaximizableWindow 是个函数，返回 true 就放行。
    if (typeof config.allowNonMaximizableWindow === "function") {
        let allowed = false;
        try {
            allowed = !!config.allowNonMaximizableWindow(win);
        } catch (err) {
            allowed = false;
        }
        if (allowed) return true;
    }

    // 显示器白名单：不在名单上的显示器上的窗口不参与平铺
    if (allowedScreens) {
        const screen = win.screen;
        if (!screen) return false;
        const screenName = String(screen.name || "").toLowerCase();
        let ok = false;
        for (const name of allowedScreens) {
            if (screenName === name || screenName.indexOf(name) >= 0) {
                ok = true;
                break;
            }
        }
        if (!ok) return false;
    }

    const bundleID = (app.bundleID || "").toLowerCase();
    const bundleList = bundleRules.get(bundleID);
    if (bundleList) {
        for (const rule of bundleList) {
            if (rule.type === "all") return false;
        }
    }

    const name = (app.name || "").toLowerCase();
    const list = appRules.get(name);
    if (!list) return true;

    const title = win.title;
    for (const rule of list) {
        if (rule.type === "all") return false;
        if (rule.type === "bundle") {
            if (rule.value === bundleID) return false;
            continue;
        }
        if (rule.type === "title") {
            // 标题为空的窗口不参与标题匹配（v1 同样如此）
            if (!title) continue;
            if (rule.pattern.test(title)) return false;
        }
    }
    return true;
}

/**
 * 枚举当前可被平铺的窗口。
 *
 * hs.window.allWindows() 会遍历所有应用做 AX 查询，实测热态约 65ms——
 * 只在启动、切换 Space、切换显示器这些时刻调用，够用；绝不做轮询。
 */
function managedWindows() {
    const result = [];
    for (const win of hs.window.allWindows()) {
        if (isAllowed(win)) result.push(win);
    }
    return result;
}

loadDefaults();

module.exports = {
    isAllowed,
    managedWindows,
    setAppFilter,
    setBundleFilter,
    rejectApp,
    setScreens,
    getScreens,
    resetRules,
    loadDefaults,
    appRules,
    bundleRules,
    compilePattern,
};
