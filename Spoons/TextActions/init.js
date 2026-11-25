// TextActions — Hammerspoon 2 Spoon
//
// 对当前选中文字执行常用清理、重排和中文符号包裹操作。
// 默认 ⌃⌥⌘T 触发；面板里选一行，或按 ⌘1~8，直接执行对应转换。
//
// v1 → v2 的变化：
//   · v1 的面板是一个 webview，因为 HS 1.1.1 的 webview→Lua 桥不稳定，
//     作者不得不把面板做成"只看不点"，只能靠 ⌘1~8 触发。
//     二代用原生 hs.chooser：点一行就能执行，⌘1~8 也照样能用。
//   · v1 复制/粘贴用全局 keyStroke，依赖"面板关闭后焦点自动回到原应用"。
//     二代可以直接把按键发给指定进程（keyStroke 的第三个参数），
//     于是面板弹出来抢焦点也不影响粘贴——⌘C/⌘V 精确送到原应用。
//   · v1 用 pcall + 嵌套 timer.doAfter 串流程；二代改成 async/await +
//     Promise，流程是线性的。
//
// 注意：二代没有 hs.pasteboard.readAllData/writeAllData，
// 只能快照"文本族"表示（纯文本/HTML/RTF/URL）。剪贴板里原本是图片
// 或 PDF 时，转换完成后无法原样还原（会被清空）。

"use strict";

// ---------------------------------------------------------------- 配置

const CONFIG = {
    copyTimeout: 0.6,         // 等剪贴板变化的最长秒数
    copyPollInterval: 0.02,   // 轮询剪贴板变化计数的间隔
    pasteboardSettleDelay: 0.08,  // 写入剪贴板后等它落定再粘贴
    pasteCompletionDelay: 0.8,    // 粘贴完成后等一会儿再还原剪贴板
    restoreClipboard: true,       // 转换后是否还原用户原本的剪贴板
    placeholder: "文字操作",

    // 面板配色。默认留空 = 用系统原生的 Liquid Glass 材质，
    // 自动适配浅色/深色模式。想让面板完全不透明就填十六进制颜色，
    // 并按需同时设置 textColor / subTextColor。
    background: null,
    textColor: null,
    subTextColor: null,
};

// ---------------------------------------------------------------- 文字转换

const TRANSFORMS = {
    // 删除所有空格（半角、空格、制表符、全角空格 U+3000）
    removeSpaces(text) {
        return text.replace(/[ \t　]/g, "");
    },

    // 取消所有换行
    removeLineBreaks(text) {
        return text.replace(/\r\n/g, "").replace(/[\r\n]/g, "");
    },

    // 给每行添加序号
    numberLines(text) {
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        return normalized.split("\n")
            .map((line, index) => (index + 1) + "." + line)
            .join("\n");
    },

    // 添加中文书名号
    wrapBookTitle(text) {
        return "《" + text + "》";
    },

    // 添加中文括号
    wrapChineseParentheses(text) {
        return "（" + text + "）";
    },

    // 全部转大写
    // v1 用的是 Lua 的 %a，只处理 ASCII。这里用 Unicode 的大小写映射，
    // 德语 ß、土耳其语 i 之类的也能正确处理——"全部"就该是全部。
    toUpper(text) {
        return text.toUpperCase();
    },

    // 全部转小写
    toLower(text) {
        return text.toLowerCase();
    },

    // 字符串反转
    // 按 Unicode 码点反转，emoji 等超出 BMP 的字符也不会被拆坏
    // （v1 的 UTF-8 字节模式在这里会出错）。
    reverseString(text) {
        return Array.from(text).reverse().join("");
    },
};

// 操作列表：每条对应 ⌘1~8 中的第 N 个
const ACTIONS = [
    { id: "removeSpaces",           text: "删除所有空格" },
    { id: "removeLineBreaks",       text: "取消所有换行" },
    { id: "numberLines",            text: "给每行添加序号" },
    { id: "wrapBookTitle",          text: "添加中文书名号" },
    { id: "wrapChineseParentheses", text: "添加中文括号" },
    { id: "toUpper",                text: "全部转大写" },
    { id: "toLower",                text: "全部转小写" },
    { id: "reverseString",          text: "字符串反转" },
];

// ---------------------------------------------------------------- 状态

const state = {
    ready: false,
    started: false,
    hotkey: null,

    chooser: null,      // hs.chooser 实例
    panelVisible: false,

    targetApp: null,     // 触发时所在的应用（⌘C/⌘V 的收件人）
    capturedText: null,  // 触发时缓存下来的选区文本
    clipboardSnapshot: null,
};

// ---------------------------------------------------------------- 小工具

function delay(seconds) {
    return new Promise((resolve) => {
        hs.timer.doAfter(seconds, resolve);
    });
}

/** 等到 predicate 返回 true；超时返回 false */
function waitFor(predicate, timeoutSeconds, interval) {
    return new Promise((resolve) => {
        let finished = false;
        let timer = null;
        let timeout = null;

        const finish = (value) => {
            if (finished) return;
            finished = true;
            if (timer) timer.stop();
            if (timeout) timeout.stop();
            resolve(value);
        };

        timer = hs.timer.doEvery(interval, () => {
            let ok = false;
            try {
                ok = predicate();
            } catch (err) {
                ok = false;
            }
            if (ok) finish(true);
        });
        timeout = hs.timer.doAfter(timeoutSeconds, () => finish(false));
    });
}

// ---------------------------------------------------------------- 剪贴板

/** 快照剪贴板里"文本族"的内容 */
function snapshotClipboard() {
    let types = [];
    try {
        types = hs.pasteboard.types() || [];
    } catch (err) {
        types = [];
    }
    const snapshot = { types: types, text: null, html: null, rtf: null, url: null, image: null };
    try {
        if (types.includes("public.utf8-plain-text")) snapshot.text = hs.pasteboard.readString();
        if (types.includes("public.html")) snapshot.html = hs.pasteboard.readHTML();
        if (types.includes("public.rtf")) snapshot.rtf = hs.pasteboard.readRTF();
        if (types.includes("public.url")) snapshot.url = hs.pasteboard.readURL();
        if (types.includes("public.tiff") || types.includes("public.png")) {
            snapshot.image = hs.pasteboard.readImage();
        }
    } catch (err) {
        console.error("TextActions: 读取剪贴板失败：" + err.message);
    }
    return snapshot;
}

/** 还原剪贴板（二代只能还原文本族与图片） */
function restoreClipboard(snapshot) {
    try {
        const reps = {};
        if (snapshot.text != null) reps["public.utf8-plain-text"] = snapshot.text;
        if (snapshot.html != null) reps["public.html"] = snapshot.html;
        if (snapshot.rtf != null) reps["public.rtf"] = snapshot.rtf;
        if (snapshot.url != null) reps["public.url"] = snapshot.url;
        if (Object.keys(reps).length > 0) {
            hs.pasteboard.writeObjects(reps);
            return;
        }
        if (snapshot.image) {
            hs.pasteboard.writeImage(snapshot.image);
            return;
        }
        hs.pasteboard.clear();
    } catch (err) {
        console.error("TextActions: 还原剪贴板失败：" + err.message);
    }
}

// ---------------------------------------------------------------- 面板

function closePanel() {
    if (state.chooser) {
        try {
            state.chooser.hide();
        } catch (err) {
            console.error("TextActions: 关闭面板失败：" + err.message);
        }
        state.chooser = null;
    }
    state.panelVisible = false;
}

function showPanel() {
    closePanel();

    const chooser = hs.chooser.create();
    state.chooser = chooser;

    // 原生材质默认就是 Liquid Glass；只有在用户明确要求时才换成实色背景。
    if (CONFIG.background) chooser.backgroundColor = HSColor.hex(CONFIG.background);
    if (CONFIG.textColor) chooser.textColor = HSColor.hex(CONFIG.textColor);
    if (CONFIG.subTextColor) chooser.subTextColor = HSColor.hex(CONFIG.subTextColor);

    // 每一行右侧的 ⌘1~⌘8 角标是 chooser 自己画的（index < 10 时），
    // 而且 ⌘1~⌘9 也是 chooser 原生处理的：直接跳到对应行并选中。
    // 所以这里不需要自己再绑一遍快捷键。
    chooser.setChoices(ACTIONS.map((action) => ({
        text: action.text,
        id: action.id,
    })));
    chooser.placeholder = CONFIG.placeholder;
    chooser.onSelect = (item) => {
        if (!item) return;   // ESC / 取消
        apply(item.id);
    };

    chooser.show();
    state.panelVisible = true;
}

// ---------------------------------------------------------------- 执行转换

/**
 * 对当前选中的文字执行一个转换。
 * @param {string} transformID 转换 id
 */
async function apply(transformID) {
    const transform = TRANSFORMS[transformID];
    if (!transform) {
        alertUser("未知文字操作");
        return;
    }

    try {
        await runTransform(transform, transformID);
    } catch (err) {
        console.error("TextActions: 执行失败：" + err.message);
    }
}

async function runTransform(transform, transformID) {
    // 优先用弹出面板时缓存下来的选区；没有就再读一次剪贴板兜底。
    let text = state.capturedText;
    state.capturedText = null;
    if (!text) {
        try {
            text = hs.pasteboard.readString();
        } catch (err) {
            text = null;
        }
    }

    if (!text) {
        if (state.clipboardSnapshot) restoreClipboard(state.clipboardSnapshot);
        alertUser("未读取到文本，请先选中文字");
        return;
    }

    const snapshot = state.clipboardSnapshot;
    state.clipboardSnapshot = null;

    try {
        hs.pasteboard.writeString(transform(text));
    } catch (err) {
        console.error("TextActions: 写入剪贴板失败：" + err.message);
        return;
    }

    // 等剪贴板落定再粘贴
    await delay(CONFIG.pasteboardSettleDelay);
    paste();

    // 等目标应用把粘贴处理完，再把用户原本的剪贴板还回去
    await delay(CONFIG.pasteCompletionDelay);
    if (CONFIG.restoreClipboard && snapshot) restoreClipboard(snapshot);
}

/** 把 ⌘V 发给触发时所在的应用 */
function paste() {
    const app = state.targetApp;
    try {
        if (app && app.isRunning) {
            // 直接投递给该进程：面板抢了焦点也不影响粘贴。
            hs.eventtap.keyStroke(["cmd"], "v", app);
        } else {
            hs.eventtap.keyStroke(["cmd"], "v");
        }
    } catch (err) {
        console.error("TextActions: 粘贴失败：" + err.message);
    }
}

function alertUser(message) {
    try {
        hs.ui.alert(message).duration(1.6).show();
    } catch (err) {
        console.error("TextActions: " + message);
    }
}

// ---------------------------------------------------------------- 捕获选区

/** 把当前选区复制到剪贴板并存下来 */
async function captureSelection() {
    const app = hs.application.frontmost();
    state.targetApp = app;
    state.capturedText = null;
    state.clipboardSnapshot = snapshotClipboard();

    if (!app) return;

    const before = hs.pasteboard.changeCount;
    try {
        // 发给具体进程：不会改变前台应用，也不会被面板抢走焦点。
        hs.eventtap.keyStroke(["cmd"], "c", app);
    } catch (err) {
        console.error("TextActions: 复制失败：" + err.message);
        return;
    }

    const changed = await waitFor(
        () => hs.pasteboard.changeCount !== before,
        CONFIG.copyTimeout,
        CONFIG.copyPollInterval
    );
    if (!changed) return;

    try {
        const text = hs.pasteboard.readString();
        if (text) state.capturedText = text;
    } catch (err) {
        console.error("TextActions: 读取选区失败：" + err.message);
    }
}

// ---------------------------------------------------------------- 生命周期

/** 显示面板 */
async function show() {
    module.exports.init();

    try {
        // 先把选区抓下来：面板弹出来之后，原窗口的选区就没了。
        await captureSelection();

        closePanel();
        showPanel();
    } catch (err) {
        console.error("TextActions: 显示面板失败：" + err.message);
    }
}

function start() {
    module.exports.init();
    if (state.started) return module.exports;
    state.started = true;

    state.hotkey = hs.hotkey.bind(["ctrl", "alt", "cmd"], "t", () => {
        show();
    }, null, null);

    console.log("TextActions: 已启动（⌃⌥⌘T）");
    return module.exports;
}

function stop() {
    closePanel();
    state.capturedText = null;
    state.clipboardSnapshot = null;
    if (state.hotkey) {
        state.hotkey.destroy();
        state.hotkey = null;
    }
    state.started = false;
    console.log("TextActions: 已停止");
    return module.exports;
}

// ---------------------------------------------------------------- 导出

module.exports = {
    name: "TextActions",
    version: "2.1.0",
    author: "djx",
    description: "对当前选中文字执行常用清理、重排和中文符号包裹操作",

    // init() 在每次 hs.spoons.load() 时都会被调用，必须幂等。
    init() {
        if (state.ready) return;
        state.ready = true;
    },

    start,
    stop,
    show,

    transforms: TRANSFORMS,
    actions: ACTIONS,
    config: CONFIG,
};
