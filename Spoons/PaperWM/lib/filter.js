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
const axutil = require("./axutil");

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

/**
 * 窗口分类。
 *
 * 三类：
 *   "tile"   普通窗口，参与平铺
 *   "float"  弹出式窗口（文件选择面板、sheet、模态框、不能最大化的窗口……）
 *            —— 不参与平铺，作为浮动窗口跟随。**它出现的时候，
 *            现有的平铺布局一点都不能动。**
 *   "ignore" 完全不管（菜单栏控件、被规则排除的窗口……）
 *
 * @param {object} win HSWindow
 * @param {boolean} trusted 这个窗口我们已经纳管了。
 *        AX 查询偶尔会因为应用正忙而失败（isStandard 会返回 false），
 *        这时候不能因为一次读取失败就把已经在布局里的窗口踢出去。
 * @returns {"tile"|"float"|"ignore"}
 */
function classify(win, trusted) {
    if (!win) return "ignore";

    // 基础过滤（对应 v1 的 setOverrideFilter）
    if (win.isMinimized) return "ignore";     // visible = true
    if (win.isFullscreen) return "ignore";    // fullscreen = false

    const app = win.application;
    if (!app) return "ignore";

    // 1. 白名单优先：命中的窗口一定是普通窗口，一定参与平铺。
    //    用户可能想平铺某个"长得像面板"的工具窗口。
    if (matchesAny(config.panelWhiteList, win)) return "tile";

    // 2. 用户自定义的弹出窗口规则
    if (matchesAny(config.panelRules, win)) return "float";

    // 3. 应用级排除规则。这些是"这个窗口不要"，不是"这是弹出窗口"，
    //    所以归到 ignore——完全不跟踪。
    if (rejectedByRules(app, win)) return "ignore";

    // 4. 显示器白名单：不在名单上的显示器上的窗口不参与平铺
    if (!onAllowedScreen(win)) return "ignore";

    // 5. 不是标准窗口（菜单栏、控件之类）。
    //    已经纳管的窗口放行——AX 查询失败时 isStandard 会返回 false，
    //    那只是一次读取失败，不代表窗口真的变了。
    if (!win.isStandard && !trusted) return "ignore";

    // 6. 弹出式窗口？
    //    macOS 原生的文件选择面板（open-panel / save-panel）、sheet、
    //    模态框都归到这里。它们出现时不能动现有的布局。
    const transient = axutil.isTransient(win);
    if (transient === true) return "float";

    // 7. 不能最大化的窗口也不能平铺——平铺完没法再调整大小。
    //    （上游 PaperWM 也是这么做的，见 axutil.js 里的说明）
    //
    //    已经纳管的窗口例外：AX 读不出结论时（null），宁可保持原状，
    //    也不要因为应用正忙的一次超时就把窗口踢出布局。
    const maximizable = axutil.isMaximizable(win);
    if (maximizable === false && !trusted) return "float";

    return "tile";
}

/**
 * 窗口是否应该参与平铺。
 *
 * 兼容老接口：只看"tile"这一类。
 */
function isAllowed(win) {
    return classify(win) === "tile";
}

/**
 * 窗口是否应该被当成浮动窗口跟踪。
 */
function isFloatingKind(win) {
    return classify(win) === "float";
}

/**
 * 匹配一条用户规则 { app?, title? }。
 */
function matchRule(rule, win) {
    if (!rule) return false;

    if (rule.app) {
        const name = String((win.application && win.application.name) || "").toLowerCase();
        if (name !== String(rule.app).toLowerCase()) return false;
    }

    if (rule.title != null) {
        const title = win.title;
        if (!title) return false;
        let pattern;
        try {
            pattern = compilePattern(rule.title);
        } catch (err) {
            return false;
        }
        if (!pattern.test(title)) return false;
    }

    return true;
}

/** 有没有规则命中 */
function matchesAny(rules, win) {
    if (!rules || !rules.length) return false;
    for (const rule of rules) {
        if (matchRule(rule, win)) return true;
    }
    return false;
}

/** 应用级排除规则命中了吗 */
function rejectedByRules(app, win) {
    const bundleID = (app.bundleID || "").toLowerCase();
    const bundleList = bundleRules.get(bundleID);
    if (bundleList) {
        for (const rule of bundleList) {
            if (rule.type === "all") return true;
        }
    }

    const name = (app.name || "").toLowerCase();
    const list = appRules.get(name);
    if (!list) return false;

    const title = win.title;
    for (const rule of list) {
        if (rule.type === "all") return true;
        if (rule.type === "bundle") {
            if (rule.value === bundleID) return true;
            continue;
        }
        if (rule.type === "title") {
            // 标题为空的窗口不参与标题匹配（v1 同样如此）
            if (!title) continue;
            if (rule.pattern.test(title)) return true;
        }
    }
    return false;
}

/** 窗口在允许平铺的显示器上吗 */
function onAllowedScreen(win) {
    if (!allowedScreens) return true;
    const screen = win.screen;
    if (!screen) return false;
    const screenName = String(screen.name || "").toLowerCase();
    for (const name of allowedScreens) {
        if (screenName === name || screenName.indexOf(name) >= 0) return true;
    }
    return false;
}


/**
 * 设置弹出式窗口规则。
 *
 * 命中的窗口会被当成浮动窗口：出现时不打乱现有布局，自己能拖能聚焦。
 *
 * @param {Array<{app?: string, title?: string}>} rules
 */
function setPanelRules(rules) {
    config.panelRules = Array.isArray(rules) ? rules.slice() : [];
    axutil.clearCache();
}

/**
 * 设置弹出式窗口白名单。
 *
 * 命中的窗口一定是普通窗口，一定参与平铺——哪怕它长得像面板
 * （没有放大按钮、identifier 带 panel 之类的）。
 *
 * @param {Array<{app?: string, title?: string}>} rules
 */
function setPanelWhiteList(rules) {
    config.panelWhiteList = Array.isArray(rules) ? rules.slice() : [];
    axutil.clearCache();
}

/**
 * 枚举所有"候选"窗口（还没分类）。
 *
 * 只做最基础的过滤（没有最小化/全屏、有归属应用），
 * 剩下的交给 classify 判断。
 */
function allWindows() {
    const result = [];
    for (const win of hs.window.allWindows()) {
        if (!win) continue;
        if (win.isMinimized) continue;
        if (win.isFullscreen) continue;
        if (!win.application) continue;
        result.push(win);
    }
    return result;
}

/**
 * 枚举当前可被平铺的窗口。
 *
 * hs.window.allWindows() 会遍历所有应用做 AX 查询，实测热态约 65ms——
 * 只在启动、切换 Space、切换显示器这些时刻调用，够用；绝不做轮询。
 */
function managedWindows() {
    const result = [];
    for (const win of allWindows()) {
        if (isAllowed(win)) result.push(win);
    }
    return result;
}

/**
 * 枚举当前应该被跟踪为浮动窗口的窗口（弹出式窗口）。
 */
function floatingWindows() {
    const result = [];
    for (const win of allWindows()) {
        if (isFloatingKind(win)) result.push(win);
    }
    return result;
}

/**
 * 解释一个窗口为什么是（或不是）平铺窗口。
 *
 * 排查问题用："这个窗口怎么没被平铺？"
 *
 * @param {object} win HSWindow
 * @returns {string}
 */
function explain(win) {
    if (!win) return "窗口为空";
    const app = win.application;
    const name = app ? (app.name || "?") : "?";
    const title = win.title || "(无标题)";

    if (win.isMinimized) return `「${title}」[${name}] 最小化了，不管`;
    if (win.isFullscreen) return `「${title}」[${name}] 全屏了，不管`;
    if (!win.isStandard) return `「${title}」[${name}] 不是标准窗口，不管`;
    if (!app) return `「${title}」取不到归属应用，不管`;

    if (matchesAny(config.panelWhiteList, win)) {
        return `「${title}」[${name}] 命中弹出窗口白名单 → 平铺`;
    }
    if (matchesAny(config.panelRules, win)) {
        return `「${title}」[${name}] 命中自定义弹出规则 → 浮动`;
    }
    if (rejectedByRules(app, win)) {
        return `「${title}」[${name}] 被应用排除规则排除 → 不管`;
    }
    if (!onAllowedScreen(win)) {
        return `「${title}」[${name}] 不在允许平铺的显示器上 → 不管`;
    }

    const transient = axutil.isTransient(win);
    if (transient === true) {
        return `「${title}」[${name}] 是弹出式窗口（面板/模态框）→ 浮动`;
    }
    if (transient === null) {
        return `「${title}」[${name}] AX 读不出是不是面板，先按普通窗口处理`;
    }

    const maximizable = axutil.isMaximizable(win);
    if (maximizable === false) {
        return `「${title}」[${name}] 不能最大化（没有放大按钮）→ 浮动`;
    }
    if (maximizable === null) {
        return `「${title}」[${name}] AX 读不出能不能最大化，先按普通窗口处理`;
    }

    return `「${title}」[${name}] 普通窗口 → 平铺`;
}

loadDefaults();

module.exports = {
    classify,
    isAllowed,
    isFloatingKind,
    allWindows,
    managedWindows,
    floatingWindows,
    setAppFilter,
    setBundleFilter,
    rejectApp,
    setScreens,
    getScreens,
    resetRules,
    setPanelRules,
    setPanelWhiteList,
    explain,
    loadDefaults,
    appRules,
    bundleRules,
    compilePattern,
};
