# PaperWM

平铺窗口管理（Tiling Window Manager）——从 Hammerspoon **一代**的 PaperWM.spoon 移植到 **二代**。

不是照抄 v1 的写法，而是按二代的能力重新实现的：v1 里那些靠"模拟 Mission Control 鼠标拖拽"
或者"轮询窗口列表"实现的功能，二代有原生 API，直接用原生 API。

---

## 快速上手

```js
const PaperWM = hs.spoons.load("PaperWM");
PaperWM.start();
```

默认不开。在 TogglePanel 面板（⌃⌥⌘K）里可以随时开关，状态会记住。

热键表在 `lib/config.js` 的 `config.hotkeys` 里，默认沿用 v1 的分配。

---

## 热键

| 动作 | 快捷键 | 说明 |
|---|---|---|
| 焦点左移 | `⌥⌘J` | |
| 焦点右移 | `⌥⌘L` | |
| 焦点上移 | `⌥⌘I` | |
| 焦点下移 | `⌥⌘K` | |
| 与左侧交换 | `⌥⌘⇧J` | |
| 与右侧交换 | `⌥⌘⇧L` | |
| 与上方交换 | `⌥⌘⇧I` | |
| 与下方交换 | `⌥⌘⇧K` | |
| 窗口居中 | `⌥⌘H` | |
| 贴到画布左/右边缘 | `⌃⌥⌘,` / `⌃⌥⌘.` | 成为视口的最左/最右锚点 |
| 窗口全宽 | `⌥⌘F` | |
| 循环宽度 | `⌥⌘R` / `⌃⌥⌘R` | 正向 / 反向 |
| 循环高度 | `⌥⌘⇧R` / `⌃⌥⌘⇧R` | 正向 / 反向 |
| 加宽 | `⌥⌘O` | |
| 变窄 | `⌥⌘U` | |
| 合并到左边一列 | `⌥⌘Y` | slurp |
| 拆成独立一列 | `⌥⌘⇧Y` | barf |
| 手风琴叠放 | `⌥⌘⇧S` | 所在列切换成叠放 |
| 左右分屏 | `⌥⌘S` | 当前列和左边那列各占一半 |
| 切换浮动 | `⌥⌘P` | |
| 聚焦所有浮动窗口 | `⌥⌘⇧F` | |
| 切换到第 n 个 Space | `⌥⌘1`…`⌥⌘9` | |
| 切回上一个 Space | `⌃⌥⌘6` | |
| 聚焦第 n 个窗口 | `⌘⇧1`…`⌘⇧9` | |
| 聚焦最左 / 最右窗口 | `⌘⇧Home` / `⌘⇧End` | |
| 把窗口移到第 n 个 Space | `⌥⌘⇧1`…`⌥⌘⇧9` | |
| 把窗口移到相邻显示器 | `⌃⌥⌘` + 方向键 | 多显示器时有效 |
| 上一个 / 下一个 Space | `⌥⌘,` / `⌥⌘.` | |
| 强制重排 | `⌥⌘⇧R` | |
| 打印当前布局 | `⌥⌘⇧D` | 调试用 |

鼠标：

| 操作 | 效果 |
|---|---|
| `⌥⌘` + 拖动 | 整组窗口左右滑动 |
| `⌥⌘⇧` + 拖动 | 把窗口从平铺里抬出来拖动，**松手落在你放的位置** |

> 拖动要求修饰键**完全一致**——⌥⌘ 是整组滑动，⌥⌘⇧ 是抬起窗口，
> 多按一个别的键就都不触发（和 v1 的 `containExactly` 一个语义）。

### 拖动时窗口为什么不会"斜着走"

抬起窗口时记下**抓取点**（窗口当时的位置 + 鼠标当时的位置），
之后窗口的位置一律从这两个值算：

```
新位置 = 抓取时的窗口位置 + (当前鼠标位置 - 抓取时的鼠标位置)
```

而不是"当前窗口位置 + 本次鼠标位移"。后者有个隐患：窗口只要在两次事件
之间被别的东西挪动过一次（系统把聚焦的窗口滚进屏幕、应用自己调整边界……），
那个偏移就会被带进下一步，越拖越歪。

另外拖动过程中**只改位置、不改大小**（直接设 `AXPosition`）。
`win.frame = rect` 会连着设位置和大小两次，而改大小常会让应用顺手调整位置
（标题栏偏移、最小尺寸约束之类），表现出来就是"斜着走"。
只设位置还顺带省掉了 HS2 每次设 frame 都要做的 enhanced-UI 开关
（一次拖动能少 4 次 AX 往返）。

---

## 过渡动画

v1 是瞬移的——它专门用 `setFrame(frame, 0)` 把 macOS 的窗口动画关掉，
因为一次平铺要同时动好几个窗口，动画会让画面乱成一团。

二代反过来：**自己实现补间动画**，让窗口"滑"过去。

```js
PaperWM.config.animation = true;        // 关掉就变回瞬移
PaperWM.config.animationDuration = 0.18; // 秒
```

实现要点：

- **所有动画共用一个定时器**（不是每个窗口一个），每帧把所有在动的窗口
  往前推一步。所以窗口多也不太费。
- 缓动是 **easeOutCubic**（起步快、收尾慢），观感接近系统窗口动画。
- 动画途中又有了新目标，就从**当前所在的位置**接着走，不跳。
- 动画途中窗口自己动了（用户真的在拖它），立刻取消动画，把控制权交回去。

> 排版的时候要读窗口的位置来算下一帧。动画进行中 `win.frame` 是中间值，
> 拿来算就会按"还没到位的尺寸"排版，动画结束后尺寸又对不上。
> 所以内部统一用 `animate.layoutFrame(win)`——有动画时返回**目标值**，
> 没有时返回当前值。

---

## 手风琴叠放（accordion）

一列窗口可以切换成"手风琴"：叠在一起，每个只露出一条标题栏，
焦点窗口是展开的那个。点别的那条边就能展开它。

```js
PaperWM.toggleStack();                              // 切换焦点窗口所在列
PaperWM.config.columnLayout = "stacked";            // 默认所有列都是叠放
PaperWM.config.accordionPeek = 36;                  // 每条露出的标题栏高度
PaperWM.config.stackMinHeight = 150;                // 窗口高度下限
```

展开的窗口**下面**的那些会超出屏幕底部——这是 PaperWM 原版的设计，
不是 bug。用 `⌥⌘I`/`⌥⌘K`（上下移动焦点）可以在叠放的列里切换展开哪一个。

---

## 新窗口的默认宽度

```js
PaperWM.config.defaultWidth = 0.5;                  // 画布宽度的一半
PaperWM.config.appWidths = {                        // 按应用覆盖
    "Google Chrome": 0.5,
    "com.apple.Safari": 0.75,
};
```

比例是相对**画布**宽度（扣掉间隙之后），不是屏幕宽度。


---

## 窗口排除规则

有些窗口不该被平铺（画中画、小窗、面板之类的）。默认已经排除了微信的图片/通话窗口、
浏览器的画中画、音乐App 的迷你播放器、Finder 的简介窗口等等。

```js
// 按应用名（显示名）+ 标题正则
PaperWM.setAppFilter("Safari", { rejectTitles: ["^画中画$"] });

// 按 Bundle ID 排除整个进程
PaperWM.setBundleFilter("com.example.helper", true);

// 排除某个应用的全部窗口
PaperWM.rejectApp("iStat Menus Status");

// 只平铺指定显示器上的窗口（传 null 恢复全部）
PaperWM.setScreens(["Built-in Retina Display"]);

// 恢复默认
PaperWM.resetRules();
```

标题匹配支持两种写法：`"^标题$"`（当作普通正则）和 `"/^标题$/i"`（带标志的正则字面量）。

有些应用明明能平铺，却报告"不可最大化"，这时可以放行：

```js
PaperWM.config.allowNonMaximizableWindow = (win) => {
    return win.application.bundleID === "net.imput.helium";
};
```

---

## 其它开关

```js
// 焦点走到两端时循环（从最左往左跳到最右）
PaperWM.config.infiniteLoopWindow = true;

// 切换 Space 时保留当前应用的前台状态
PaperWM.config.preserveAppFocus = true;

// 用 move_window_N 把窗口移走之后，留在当前 Space 不跟着走
PaperWM.config.moveWindowKeepSpace = true;

// 切换 Space 之后把鼠标移到屏幕中央
PaperWM.config.centerMouse = true;
```

---

## 布局跟着焦点走

焦点窗口永远是"锚点"——它会被拉回屏幕可见范围，其余窗口跟着左右滑动，
手感类似 niri：

- 点一下屏幕边缘露出来的半个窗口 → 它整个滑进屏幕，其余窗口让位
- ⌘Tab 切到另一个应用的窗口 → 那个窗口滑进屏幕
- 窗口跑到屏幕外了 → 点它一下就回来了

具体规则和 v1 一致：焦点窗口成为锚点，被夹进画布（`canvas`）里，
锚点所在列往右依次铺开，左边的列被推出屏幕外。

> v1 里这一步是隐含在 `hs.window.filter` 的 `windowFocused` 订阅里的——
> 二代没有 `window.filter`，所以移植时要自己接上：
> 每应用一个 AX 观察者收 `focusedWindowChanged` / `mainWindowChanged`，
> 再用 `hs.application.on("didActivate")` 兜底（有些应用不接受 AX 观察）。

每个 Space 还会记住自己的锚点。你在别的 Space 上干活时，这边某个窗口
被系统挪了一下，布局不会莫名其妙地跳——它会继续用上次那个锚点。

---

## 和 v1 的差别

### Space 操作：440 行 → 0 行

v1 的 `mission_control.lua` 要开 Mission Control、算出窗口在屏幕上的位置、
模拟鼠标拖拽、再等动画结束——一共 440 行，而且经常失手（拖到一半系统动画还没结束、
窗口不在预期位置、拖拽落点偏了……）。

二代有原生 Spaces 支持：

```js
space.goto()                 // 切换 Space
win.moveToSpace(space)       // 把窗口移到别的 Space
```

一行就够，而且是系统自己做的，不会失手。

### 事件层：hs.window.filter → AX 观察者

v1 用 `hs.window.filter` 的订阅拿到窗口事件。二代没有这个子模块，
改用 `hs.ax` 的 AX 观察者：

- 每个应用挂一个，收 `windowCreated` / `focusedWindowChanged` / `mainWindowChanged`
- 每个受管窗口挂一个，收 `windowMoved` / `windowResized` / `uIElementDestroyed`

**依然是完全事件驱动的，没有轮询。**

> ⚠️ 踩坑记录：`hs.ax.on(element, [a, b, c], fn)` 传数组时是**全有或全无**的——
> 只要有一个通知不被支持，已经注册的那些也会被撤销。所以必须一个一个注册。

> ⚠️ 另一个坑：注册用原始名（`"AXWindowCreated"`），回调收到的却是短名
> （`"windowCreated"`）。两者不一样，直接比较会永远匹配不上。
> `lib/ax.js` 把两套名字放在一起，就是为了避免这个坑。

### 修饰键的匹配

拖动窗口靠的是"按住 ⌥⌘（或 ⌥⌘⇧）再拖"。

v1 用 `flags:containExactly()` 判断修饰键**完全一致**——多按一个 ⇧ 就是另一套操作。
这个语义保留下来了，但二代的 `event.flags` 数组和 v1 不一样：

```
v1:  ["alt", "cmd"]
二代: ["cmd", "alt", "leftAlt"]     ← 左边还多带一个"哪一侧按下"的名字
```

（顺带一提，HS2 里这些侧面名字的掩码和系统的 `NX_DEVICE*KEYMASK` 常量没对齐，
按住 ⌃ 会被报成 `"leftCmd"`。所以更不能直接拿这些名字当键名用。）

所以匹配时只取基本名（`cmd` / `alt` / `shift` / `ctrl`），
`leftCmd`、`rightAlt` 之类的一律忽略，`fn` 和 `capslock` 也不参与比较。
详见 `lib/mouse.js` 的 `primaryFlags()`。

### 自我触发的抑制

v1 靠"移动时停掉监听器、动画结束后再装回去"来避免自己触发自己重排。

二代没有窗口动画（v1 需要 `setFrame(frame, 0)` 专门禁掉 200ms 的过渡动画），
所以换个更简单的办法：记下"我们要求的 frame"，事件回来时比对，吻合就忽略。

但有个细节：一次移动会同时改位置和大小，AX 往往回报**两个**事件。
所以不能"匹配上就删掉期望"——第二个事件就找不到期望了，会被误判成用户拖动。
这里的做法是期望值带时间戳，匹配上就刷新时间戳而不是删掉。

### 死窗口的清理

窗口被关掉时 AX 有时不送 `uIElementDestroyed`（应用被强杀、窗口是面板之类）。
死掉的窗口 frame 是空的——查一下就知道，比问"这窗口还在不在"便宜得多。
每次平铺前顺手清一遍，免得死窗口一直占着列，布局错位。

⚠️ **清掉列之后必须重建索引表**。列一被删，后面所有列的编号都往前挪一位，
索引表要是不同步，排版时就会拿着过期的列号，把锚点窗口当成"左边那一列"
铺到屏幕最左边——表现出来就是**窗口贴在屏幕左边，右侧反而空出来**。
这个 bug 表现为"有概率"出现：AX 的销毁事件送到时就正常，送不到时才犯。

所以排版时找锚点那一列、删窗口时找它那一列，都改成**实际搜**，
不信索引表里可能过期的列号。

### 窗口查找

v1 有 `hs.window.filter` 这个专门的窗口索引。二代只有 `hs.window.allWindows()`
（实测冷启动 2.4 秒，热了 60～100 毫秒），**绝不能轮询**。

所以这里只在三个时机扫全量列表：启动、切换 Space、屏幕配置变化。
平时全靠 AX 事件增量更新。

---

## 没移植的部分

**触摸板滑动手势**。v1 用 `hs.eventtap` 的私有 gesture 事件类型，
Hammerspoon 2 没有暴露这个事件类型，所以没法移植。

v1 的默认配置里它本来就是关的（`swipe_fingers = 0`），
而且用上面的 `⌥⌘` + 拖动或滚轮能达到同样的效果。

## 文件结构

```
Spoons/PaperWM/
├── spoon.json
├── init.js          入口，导出 start/stop 和各种 API
└── lib/
    ├── ax.js        AX 通知名（原始名 / 短名）
    ├── animate.js   过渡动画（补间）
    ├── config.js    配置与热键表
    ├── state.js     运行时状态（布局、索引、观察者……）
    ├── filter.js    窗口过滤（哪些窗口该被平铺）
    ├── stack.js     手风琴叠放的状态
    ├── tiling.js    布局引擎（把窗口铺到该在的位置）
    ├── actions.js   动作（聚焦、交换、合并、拆分、浮动……）
    ├── spaces.js    Space 相关
    ├── events.js    事件层（AX 观察者）
    ├── hotkeys.js   热键
    └── mouse.js     鼠标（滑动、抬起）
```

---

## 致谢

移植自 [PaperWM](https://github.com/PaperWM-org/paperwm)，
原作者 Sindre Sorhus、Marco Arment、Jesse Wornell 等人，MIT 协议。
布局算法原样保留——那套算法是 PaperWM 的核心，经得起检验。

本移植版本（作者 djx）仅适配 Hammerspoon 2 的 API，未修改上游算法。
