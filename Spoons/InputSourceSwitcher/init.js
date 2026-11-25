// InputSourceSwitcher — Hammerspoon 2 Spoon
//
// 根据当前活跃应用的 Bundle ID 自动切换中英文输入源；未配置的应用保持不变。
//
// v1 → v2 的变化：
//   · v1 用 hs.application.watcher.new(...) 的回调式 API；
//     二代改成 hs.application.on('didActivate', fn) / off(...)，监听器由模块自己管，
//     少一层对象、少一次 Lua→Swift 跨界。
//   · v1 用 hs.keycodes.currentSourceID(id) 一个函数兼做读写；
//     二代拆成 currentSourceID() 和 setSourceID(id)，意图更清楚。
//   · v1 的提示是一个 webview；二代交给 Notice Spoon（原生 SwiftUI），
//     并且在提示弹出后把焦点还给用户正在用的应用。

"use strict";

// ---------------------------------------------------------------- 配置

// 提示文案：用户可见的简写，避免 ASCII 全角混乱。
const NOTICE_LABELS = {
    english: "EN · ABC",
    chinese: "中 · 拼音",
};

const NOTICE_DURATION = 0.9;

// macOS 内置 ABC 与简体拼音输入源 ID。
const SOURCE_IDS = {
    english: "com.apple.keylayout.ABC",
    chinese: "com.apple.inputmethod.SCIM.ITABC",
};

// 规则只认 Bundle ID，不依赖中英文应用显示名。
const RULES = {
    english: {
        // 终端
        "io.appmakes.otty": true,
        "com.mitchellh.ghostty": true,
        "com.apple.Terminal": true,
        "com.googlecode.iterm2": true,

        // 浏览器
        "com.apple.Safari": true,
        "com.google.Chrome": true,
        "company.thebrowser.Browser": true, // Arc
        "org.mozilla.firefox": true,
        "com.microsoft.edgemac": true,

        // 常见编辑器（代码输入默认英文）
        "com.microsoft.VSCode": true,
        "com.todesktop.230313mzl4w4u92": true, // Cursor
        "com.sublimetext.4": true,
        "com.jetbrains.intellij": true,
    },
    chinese: {
        "com.microsoft.Word": true,
        "com.tencent.xinWeChat": true,
        "com.tencent.qq": true,
    },
};

// ---------------------------------------------------------------- 状态

const state = {
    ready: false,
    started: false,
    notice: null,
    onActivate: null,
    // 切换过程中的重入保护：setSourceID 会触发输入源变化，
    // 而应用激活也可能被我们自己的 activate() 引发。
    switching: false,
};

// ---------------------------------------------------------------- Notice

/** 拿到 Notice Spoon；没装就退回系统通知 */
function noticeModule() {
    if (state.notice) return state.notice;
    try {
        state.notice = hs.spoons.load("Notice");
    } catch (err) {
        console.error("InputSourceSwitcher: 找不到 Notice Spoon，" +
            "提示将改用系统通知。原因：" + err.message);
        state.notice = null;
    }
    return state.notice;
}

function showNotice(label) {
    const notice = noticeModule();
    if (notice && typeof notice.show === "function") {
        // 用默认的居中锚点：叠放式提示不抢焦点，
        // 用户在 Dock / ⌘+Tab 切换应用时不会被打断。
        notice.show(label, null, NOTICE_DURATION, "center");
        return;
    }
    try {
        hs.notify.show(label, "");
    } catch (err) {
        console.error("InputSourceSwitcher: 提示失败：" + err.message);
    }
}

// ---------------------------------------------------------------- 核心逻辑

/** 根据 Bundle ID 解析出应该使用哪个输入源 */
function resolveMode(bundleID) {
    if (!bundleID) return null;
    if (RULES.english[bundleID]) return "english";
    if (RULES.chinese[bundleID]) return "chinese";
    return null;
}

/** 为某个应用切换输入源；返回是否真的切换了 */
function applyForApplication(app) {
    if (!app || state.switching) return false;

    const bundleID = app.bundleID;
    const mode = resolveMode(bundleID);
    if (!mode) return false;

    const targetSourceID = SOURCE_IDS[mode];
    if (hs.keycodes.currentSourceID() === targetSourceID) return false;

    state.switching = true;
    let switched = false;
    try {
        switched = hs.keycodes.setSourceID(targetSourceID);
    } catch (err) {
        console.error("InputSourceSwitcher: 切换输入源出错：" + err.message);
    } finally {
        state.switching = false;
    }

    if (switched) {
        console.log("InputSourceSwitcher: " + bundleID + " → " + mode);
        showNotice(NOTICE_LABELS[mode]);
    } else {
        console.error("InputSourceSwitcher: 无法为 " + bundleID +
            " 切换输入源：" + targetSourceID);
    }
    return switched;
}

function applyToFrontmostApplication() {
    return applyForApplication(hs.application.frontmost());
}

// ---------------------------------------------------------------- 生命周期

function start() {
    module.exports.init();
    if (state.started) return module.exports;
    state.started = true;

    state.onActivate = (app) => applyForApplication(app);
    hs.application.on("didActivate", state.onActivate);

    // 启动后立即处理当前应用，不必等待下一次切换窗口。
    hs.timer.doAfter(0, applyToFrontmostApplication);

    return module.exports;
}

function stop() {
    if (state.started) {
        if (state.onActivate) {
            hs.application.off("didActivate", state.onActivate);
            state.onActivate = null;
        }
        state.started = false;
    }
    return module.exports;
}

// ---------------------------------------------------------------- 导出

module.exports = {
    name: "InputSourceSwitcher",
    version: "2.0.0",
    author: "djx",
    description: "按当前活跃应用的 Bundle ID 自动切换中英文输入源",

    // init() 在每次 hs.spoons.load() 时都会被调用，必须幂等。
    init() {
        if (state.ready) return;
        state.ready = true;
    },

    start,
    stop,

    // 便于外部覆盖规则，例如：
    //   const s = hs.spoons.load("InputSourceSwitcher")
    //   s.setRules({ english: { "com.example.app": true } })
    setRules(rules) {
        for (const key of Object.keys(RULES)) delete RULES[key];
        Object.assign(RULES, rules || {});
        return module.exports;
    },

    rules: RULES,
    sourceIDs: SOURCE_IDS,
    resolveMode,
    applyForApplication,
    applyToFrontmostApplication,
};
