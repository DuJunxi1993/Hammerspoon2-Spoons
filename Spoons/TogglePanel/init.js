// TogglePanel — Hammerspoon 2 Spoon
//
// 插件开关面板：一眼看到各个 Spoon 的开关状态，选一行就切换。
// ⌃⌥⌘K 打开；⌘1~4 切换对应插件；⌘0 一键全开/全关；ESC 关闭。
//
// v1 → v2 的变化（这是二代最值得改的一处）：
//   v1 的开关流程是「改写 config.lua → hs.reload() → init.lua 重新读取
//   → 决定起哪个 Spoon」。也就是说每切一次开关，整个 Hammerspoon 就重载一遍：
//   所有 Spoon 重新初始化、所有热键重新绑定、面板还要靠 reloadScheduled
//   机制在重载后把自己再弹出来一圈。
//
//   二代没有 hs.reload()，也不需要：hs.spoons.load() 返回的是同一个缓存对象，
//   直接调它的 start() / stop() 就完事了。开关是即时的——
//   面板不闪、不重载、别的 Spoon 不受影响。
//
//   状态存在 hs.userdefaults（JSON 字符串），重启后还在。
//   不再需要额外维护一个 config.lua。
//
// 面板用 HS2 原生的 hs.chooser，而不是自己拼一个 SwiftUI 窗口：
//   · 原生外观，自动适配浅色/深色模式
//   · 自带搜索框、↑↓ 选择、回车确认、ESC 关闭
//   · 关闭时会把焦点还给打开它之前的那个应用

"use strict";

// ---------------------------------------------------------------- 配置

const CONFIG = {
    defaultsKey: "hammerspoon2.toggledSpoons",
    placeholder: "插件开关",
    onMark: "●",
    offMark: "○",
    missingMark: "—",

    // 面板配色。默认留空 = 用系统原生的 Liquid Glass 材质，
    // 自动适配浅色/深色模式；面板背后的内容会被模糊透出（macOS 原生观感）。
    // 如果想让面板完全不透明（例如背后窗口很花），把 background 设成十六进制
    // 颜色，并按需同时设置 textColor / subTextColor。
    // 注意：HS2 没有暴露系统的语义颜色，所以这里填的颜色不会自动跟随模式切换。
    background: null,   // 例如 "#F2F2F7"
    textColor: null,    // 例如 "#1C1C1E"
    subTextColor: null, // 例如 "#6E6E73"
    cornerRadius: 12,
};

// 可被切换的 Spoon。顺序即 ⌘1、⌘2…… 的顺序。
const ENTRIES = [
    {
        name: "ResizeMouse",
        label: "ResizeMouse",
        sub: "⌃⇧ 调大小 · ⌃⌥ 移动窗口",
    },
    {
        name: "TextActions",
        label: "TextActions",
        sub: "文字操作 ⌃⌥⌘T",
    },
    {
        name: "PaperWM",
        label: "PaperWM",
        sub: "平铺窗口管理",
    },
    {
        name: "WindowInspector",
        label: "WindowInspector",
        sub: "窗口检查 ⌃⌥⌘I",
    },
    {
        name: "InputSourceSwitcher",
        label: "InputSourceSwitcher",
        sub: "按应用自动切换中英文输入源",
    },
];

// 默认开关状态（沿用 v1 config.lua 里的设定）。
const DEFAULT_STATE = {
    ResizeMouse: true,
    TextActions: true,
    PaperWM: false,
    WindowInspector: false,
    InputSourceSwitcher: false,
};

// ---------------------------------------------------------------- 状态

const state = {
    ready: false,
    started: false,
    hotkey: null,

    chooser: null,      // hs.chooser 实例
    keyTap: null,       // 面板可见期间的 keyDown tap（只为 ⌘1~N / ⌘0）
    panelVisible: false,

    enabled: {},        // name -> bool
    loaded: {},         // name -> Spoon 模块对象
    unavailable: {},    // name -> true（没装 / 加载失败）
};

// ---------------------------------------------------------------- 持久化

function readState() {
    let raw = null;
    try {
        raw = hs.userdefaults.get(CONFIG.defaultsKey);
    } catch (err) {
        raw = null;
    }
    const result = Object.assign({}, DEFAULT_STATE);
    if (typeof raw !== "string" || raw.length === 0) return result;
    try {
        const parsed = JSON.parse(raw);
        for (const entry of ENTRIES) {
            if (typeof parsed[entry.name] === "boolean") {
                result[entry.name] = parsed[entry.name];
            }
        }
    } catch (err) {
        console.error("TogglePanel: 读取保存的状态失败，改用默认值：" + err.message);
    }
    return result;
}

function writeState() {
    try {
        hs.userdefaults.set(CONFIG.defaultsKey, JSON.stringify(state.enabled));
    } catch (err) {
        console.error("TogglePanel: 保存状态失败：" + err.message);
    }
}

// ---------------------------------------------------------------- Spoon 管理

/** 载入（并缓存）一个 Spoon；没装或加载失败时返回 null */
function loadSpoon(name) {
    if (state.loaded[name]) return state.loaded[name];
    try {
        const spoon = hs.spoons.load(name);
        if (!spoon) throw new Error("load() 返回了 null");
        state.loaded[name] = spoon;
        state.unavailable[name] = false;
        return spoon;
    } catch (err) {
        state.unavailable[name] = true;
        console.error("TogglePanel: 无法加载 " + name + "：" + err.message);
        return null;
    }
}

/** 启停某个 Spoon */
function setEnabled(name, enabled, { persist = true, refresh = true } = {}) {
    const spoon = loadSpoon(name);
    if (!spoon) {
        state.enabled[name] = false;
        if (persist) writeState();
        if (refresh) refreshPanel();
        return false;
    }

    try {
        if (enabled) {
            if (typeof spoon.start === "function") spoon.start();
        } else if (typeof spoon.stop === "function") {
            spoon.stop();
        }
    } catch (err) {
        console.error("TogglePanel: 切换 " + name + " 失败：" + err.message);
        return false;
    }

    state.enabled[name] = enabled;
    if (persist) writeState();
    if (refresh) refreshPanel();
    return true;
}

/** 按当前状态启停所有 Spoon */
function applyState() {
    for (const entry of ENTRIES) {
        const spoon = loadSpoon(entry.name);
        if (!spoon) continue;
        const want = state.enabled[entry.name] === true;
        try {
            if (want) {
                if (typeof spoon.start === "function") spoon.start();
            } else if (typeof spoon.stop === "function") {
                spoon.stop();
            }
        } catch (err) {
            console.error("TogglePanel: 应用 " + entry.name + " 的状态失败：" + err.message);
        }
    }
}

/** 一键全开 / 全关：只要有任一开启就全关，否则全开 */
function toggleAll() {
    const anyOn = ENTRIES.some((entry) => state.enabled[entry.name] === true);
    const target = !anyOn;
    for (const entry of ENTRIES) {
        // 面板只在全部处理完之后刷新一次，不要一行一次
        setEnabled(entry.name, target, { persist: false, refresh: false });
    }
    writeState();
    refreshPanel();
}

// ---------------------------------------------------------------- 面板

/** 面板每一行的内容 */
function buildChoices() {
    const rows = ENTRIES.map((entry) => {
        const on = state.enabled[entry.name] === true;
        const missing = state.unavailable[entry.name] === true;
        const mark = missing ? CONFIG.missingMark : (on ? CONFIG.onMark : CONFIG.offMark);
        const status = missing ? "未安装" : (on ? "已开启" : "已关闭");
        return {
            text: entry.label,
            subText: mark + " " + status + " · " + entry.sub,
            id: entry.name,
        };
    });
    rows.push({
        text: "全部",
        subText: "⌘0 一键开关所有插件",
        id: "__all__",
    });
    return rows;
}

function closePanel() {
    if (state.keyTap) {
        hs.eventtap.removeWatcher(state.keyTap);
        state.keyTap = null;
    }
    if (state.chooser) {
        try {
            state.chooser.hide();
        } catch (err) {
            console.error("TogglePanel: 关闭面板失败：" + err.message);
        }
        state.chooser = null;
    }
    state.panelVisible = false;
}

/** 刷新面板内容（切换之后更新状态显示） */
function refreshPanel() {
    if (!state.panelVisible || !state.chooser) return;
    // 选中一行之后 chooser 会自己关掉，这里更新内容再把它弹回来
    state.chooser.setChoices(buildChoices());
    state.chooser.show();
}

function showPanel() {
    closePanel();

    const chooser = hs.chooser.create();
    state.chooser = chooser;

    // 原生材质默认就是 Liquid Glass；只有在用户明确要求时才换成实色背景。
    if (CONFIG.background) chooser.backgroundColor = HSColor.hex(CONFIG.background);
    if (CONFIG.textColor) chooser.textColor = HSColor.hex(CONFIG.textColor);
    if (CONFIG.subTextColor) chooser.subTextColor = HSColor.hex(CONFIG.subTextColor);
    if (CONFIG.cornerRadius) chooser.cornerRadius = CONFIG.cornerRadius;

    chooser.setChoices(buildChoices());
    chooser.placeholder = CONFIG.placeholder;
    chooser.onSelect = (item) => {
        if (!item) return;   // ESC / 取消
        if (item.id === "__all__") {
            toggleAll();
        } else {
            setEnabled(item.id, state.enabled[item.id] !== true);
        }
    };

    chooser.show();
    state.panelVisible = true;
    bindPanelKeys();
}

/**
 * 面板可见期间的键盘：只处理 ⌘0（一键全开/全关，沿用 v1 的习惯）。
 *
 * 其余快捷键都交给 chooser 原生处理：它会自己给每一行画上 ⌘1~⌘9 的角标，
 * 并且 ⌘1~⌘9 会直接跳到对应行并选中它。这里的 tap 必须把其它按键原样
 * 放行（return emit），否则 chooser 的原生处理就收不到了。
 */
function bindPanelKeys() {
    if (state.keyTap) hs.eventtap.removeWatcher(state.keyTap);

    state.keyTap = hs.eventtap.addWatcher(
        [hs.eventtap.eventTypes.keyDown],
        (event) => {
            if (!state.panelVisible) return hs.eventtap.emit;

            const flags = event.flags || [];
            if (flags.includes("cmd") && !flags.includes("alt") &&
                !flags.includes("ctrl") && !flags.includes("shift")) {
                const characters = event.characters;
                if (characters === "0") {
                    toggleAll();
                    return hs.eventtap.consume;
                }
            }

            return hs.eventtap.emit;   // 其余交给 chooser
        },
        false
    );
    if (state.keyTap) state.keyTap.start();
}

// ---------------------------------------------------------------- 生命周期

function start() {
    module.exports.init();
    if (state.started) return module.exports;
    state.started = true;

    state.enabled = readState();
    applyState();

    state.hotkey = hs.hotkey.bind(["ctrl", "alt", "cmd"], "k", () => {
        if (state.panelVisible) closePanel();
        else showPanel();
    }, null, null);

    console.log("TogglePanel: 已启动（⌃⌥⌘K）");
    return module.exports;
}

function stop() {
    closePanel();
    if (state.hotkey) {
        state.hotkey.destroy();
        state.hotkey = null;
    }
    state.started = false;
    console.log("TogglePanel: 已停止");
    return module.exports;
}

// ---------------------------------------------------------------- 导出

module.exports = {
    name: "TogglePanel",
    version: "2.1.0",
    author: "djx",
    description: "插件开关面板：实时启停各个 Spoon，无需重载配置",

    // init() 在每次 hs.spoons.load() 时都会被调用，必须幂等。
    init() {
        if (state.ready) return;
        state.ready = true;
    },

    start,
    stop,

    show: showPanel,
    hide: closePanel,

    entries: ENTRIES,
    setEnabled,
    toggleAll,

    isEnabled(name) { return state.enabled[name] === true; },
    get enabled() { return Object.assign({}, state.enabled); },
    get panelVisible() { return state.panelVisible; },
    get keyTapActive() { return state.keyTap !== null; },
};
