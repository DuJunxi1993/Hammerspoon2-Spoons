// WindowInspector — Hammerspoon 2 Spoon
//
// 检查当前聚焦窗口，列出它的关键属性，并生成可直接粘贴使用的
// "窗口排除规则"代码片段。
//
// v1 → v2 的变化：
//   · v1 读 window:role() / window:subrole()；二代没有这两个方法，
//     改从 window.axElement().role / .subrole 取——同一个 AX 元素，
//     不额外发起查询。
//   · v1 生成的是 Lua 片段（PaperWM.window_filter:setAppFilter(...)）。
//     二代没有 hs.window.filter 这种子模块，"过滤器"就是一个普通函数，
//     所以这里生成的是 JavaScript 片段：函数 + 用法示例。
//   · v1 用 hs.alert 提示"已复制"；二代用 hs.ui.alert 的原生提示条。

"use strict";

const CONFIG = {
    placeholder: "WindowInspector：选择要复制的内容",
    alertDuration: 1.4,

    // 面板配色。默认留空 = 用系统原生的 Liquid Glass 材质，自动适配深浅色。
    background: null,
    textColor: null,
    subTextColor: null,
};

// ---------------------------------------------------------------- 状态

const state = {
    ready: false,
    started: false,
    hotkey: null,
    chooser: null,
    lastInspection: null,
};

// ---------------------------------------------------------------- 小工具

function display(value) {
    if (value === null || value === undefined || value === "") return "（空）";
    return String(value);
}

/** 转义正则元字符，让标题里的 . [ ] ( ) 等按字面匹配 */
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alertUser(message) {
    try {
        hs.ui.alert(message).duration(CONFIG.alertDuration).show();
    } catch (err) {
        console.error("WindowInspector: " + message);
    }
}

// ---------------------------------------------------------------- 采集

/**
 * 读取窗口信息；不传参数时读取当前聚焦窗口。
 * @param {object=} window HSWindow
 */
function inspect(window) {
    const win = window || hs.window.focusedWindow();
    if (!win) return null;

    const app = win.application;
    const element = win.axElement();

    const info = {
        appName: app ? app.name : null,
        bundleID: app ? app.bundleID : null,
        pid: app ? app.pid : null,
        title: win.title,
        id: win.id,
        role: element ? element.role : null,
        subrole: element ? element.subrole : null,
        frame: win.frame,
    };
    state.lastInspection = info;
    return info;
}

/** 把窗口属性格式化为适合查看和复制的中文文本 */
function formatDetails(info) {
    if (!info) return "";
    const frame = info.frame;
    const frameText = frame
        ? "x=" + display(frame.x) + ", y=" + display(frame.y) +
          ", " + display(frame.w) + " × " + display(frame.h)
        : "（空）";

    return [
        "应用名称：" + display(info.appName),
        "Bundle ID：" + display(info.bundleID),
        "进程 PID：" + display(info.pid),
        "窗口标题：" + display(info.title),
        "窗口 ID：" + display(info.id),
        "AXRole：" + display(info.role),
        "AXSubrole：" + display(info.subrole),
        "窗口位置与尺寸：" + frameText,
    ].join("\n");
}

/**
 * 生成"按应用名 + 窗口标题精确排除"的 JavaScript 片段。
 * 二代没有 hs.window.filter，"过滤器"就是一个返回布尔的普通函数。
 */
function generateTitleRule(info) {
    if (!info) return "";
    const appName = JSON.stringify(display(info.appName));
    const title = JSON.stringify(display(info.title));
    const pattern = "^" + escapeRegExp(display(info.title)) + "$";

    return [
        "// 按应用名 + 窗口标题精确排除：",
        "const excludedTitles = [new RegExp(" + JSON.stringify(pattern) + ")];",
        "const excludedAppName = " + appName + ";",
        "",
        "function isWindowAllowed(win) {",
        "    const app = win.application;",
        "    if (!app || app.name !== excludedAppName) return true;",
        "    const title = win.title || \"\";",
        "    return !excludedTitles.some((re) => re.test(title));",
        "}",
        "",
        "// 用法：",
        "// const managed = hs.window.allWindows().filter(isWindowAllowed);",
        "// 标题：" + title,
    ].join("\n");
}

/**
 * 生成"按 Bundle ID 排除该进程全部窗口"的 JavaScript 片段。
 */
function generateBundleRule(info) {
    if (!info) return "";
    const bundleID = JSON.stringify(display(info.bundleID));

    return [
        "// 按 Bundle ID 排除该进程产生的全部窗口：",
        "const excludedBundleID = " + bundleID + ";",
        "",
        "function isWindowAllowed(win) {",
        "    const app = win.application;",
        "    return !(app && app.bundleID === excludedBundleID);",
        "}",
        "",
        "// 用法：",
        "// const managed = hs.window.allWindows().filter(isWindowAllowed);",
    ].join("\n");
}

// ---------------------------------------------------------------- 面板

function showChooser(info) {
    closeChooser();

    const chooser = hs.chooser.create();
    state.chooser = chooser;

    // 原生材质默认就是 Liquid Glass；只有在用户明确要求时才换成实色背景。
    if (CONFIG.background) chooser.backgroundColor = HSColor.hex(CONFIG.background);
    if (CONFIG.textColor) chooser.textColor = HSColor.hex(CONFIG.textColor);
    if (CONFIG.subTextColor) chooser.subTextColor = HSColor.hex(CONFIG.subTextColor);

    chooser.setChoices([
        {
            text: "窗口属性",
            subText: "回车：复制完整属性",
            payload: formatDetails(info),
        },
        {
            text: "生成：按标题排除规则",
            subText: "仅排除当前应用中标题完全相同的窗口",
            payload: generateTitleRule(info),
        },
        {
            text: "生成：按 Bundle ID 排除规则",
            subText: "排除该进程产生的全部窗口，适合运行时弹窗宿主",
            payload: generateBundleRule(info),
        },
    ]);

    chooser.placeholder = CONFIG.placeholder;
    chooser.onSelect = (item) => {
        if (!item) return;
        try {
            hs.pasteboard.writeString(item.payload);
            alertUser("已复制到剪贴板");
        } catch (err) {
            console.error("WindowInspector: 复制失败：" + err.message);
        }
    };

    chooser.show();
    return chooser;
}

function closeChooser() {
    if (state.chooser) {
        try {
            state.chooser.hide();
        } catch (err) {
            // 关闭失败不影响后续操作
        }
        state.chooser = null;
    }
}

/** 检查当前聚焦窗口，并打开结果面板 */
function show() {
    const info = inspect();
    if (!info) {
        alertUser("当前没有可识别的聚焦窗口");
        return;
    }
    showChooser(info);
}

// ---------------------------------------------------------------- 生命周期

function start() {
    module.exports.init();
    if (state.started) return module.exports;
    state.started = true;

    state.hotkey = hs.hotkey.bind(["ctrl", "alt", "cmd"], "i", () => {
        show();
    }, null, null);

    console.log("WindowInspector: 已启动（⌃⌥⌘I）");
    return module.exports;
}

function stop() {
    closeChooser();
    if (state.hotkey) {
        state.hotkey.destroy();
        state.hotkey = null;
    }
    state.started = false;
    console.log("WindowInspector: 已停止");
    return module.exports;
}

// ---------------------------------------------------------------- 导出

module.exports = {
    name: "WindowInspector",
    version: "2.1.0",
    author: "djx",
    description: "检查当前聚焦窗口，并生成窗口排除规则",

    // init() 在每次 hs.spoons.load() 时都会被调用，必须幂等。
    init() {
        if (state.ready) return;
        state.ready = true;
    },

    start,
    stop,
    show,

    inspect,
    formatDetails,
    generateTitleRule,
    generateBundleRule,
    get lastInspection() { return state.lastInspection; },
};
