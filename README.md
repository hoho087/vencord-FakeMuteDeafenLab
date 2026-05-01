# FakeMuteDeafenLab
![image](https://github.com/hoho087/vencord-FakeMuteDeafenLab/blob/main/image.png)

A Vencord user plugin that keeps local RTC media usable while you control Discord's visible mute/deafen state yourself.

## Features

- One compact Fake Mute/Deafen entry near Discord's lower-left voice controls.
- Click the entry to open a small menu with:
  - **Fake Mute**
  - **Fake Deafen**
- Plugin settings page controls for the same toggles.
- Automatic local mic/listen restoration while fake states are enabled.
- Re-applies local restoration after voice reconnects or channel switches.
- Small DevTools helpers for status checks after Discord updates.

## Installation

1. Copy this folder to your Vencord user plugins directory:

   ```text
   src/userplugins/fakeMuteDeafenLab
   ```

2. Build Vencord and restart Discord.
3. Enable **FakeMuteDeafenLab** in Vencord plugins.

Build command from the Vencord repo root:

```powershell
cd D:\code\Vencord
node --require=./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs
```

## Usage

1. Join a voice channel.
2. Use Discord's own Mute / Deafen buttons to choose the visible state other users should see.
3. Click the FakeMuteDeafenLab panel button and enable:
   - **Fake Mute**: keep local voice input restored while you are visibly muted.
   - **Fake Deafen**: keep local input/output restored while you are visibly deafened.
4. You can also control the plugin from **Vencord Settings -> Plugins -> FakeMuteDeafenLab**.

## Optional settings

- **Show quick toggles**: show or hide the lower-left FakeMuteDeafenLab panel entry.
- **Auto restore local media**: periodically re-apply local mic/listen restoration while fake states are enabled.
- **Restore delay**: delay before local media is restored after a voice/media state change.
- **Debug logs**: print concise logs to DevTools.

## DevTools helpers

```js
FakeMuteDeafenLabStatus()
FakeMuteDeafenLabSetMute(true)
FakeMuteDeafenLabSetDeafen(true)
FakeMuteDeafenLabRestoreLocal()
```

## How it works

Discord has a visible voice state (`selfMute` / `selfDeaf`) and a local RTC media connection. This plugin no longer changes the visible voice state through Discord Flux actions. Instead, it only restores the local RTC media connection with the available RTC media methods while the fake toggles are enabled.

If a Discord update breaks the plugin, the most likely areas to inspect are:

- `RTCConnection` module detection
- the internal `_connection` object
- local media methods such as `setSelfMute`, `setSelfDeaf`, `setAudioEnabled`, or renamed equivalents
- changes in Discord's media connection behavior

---

# FakeMuteDeafenLab（中文）

這是一個 Vencord user plugin，用來在 fake 狀態啟用時恢復本地 RTC media 功能；Discord 對外顯示的 mute / deafen 狀態由你自己用原生按鈕控制。

## 功能

- 在 Discord 左下角語音控制附近加入一個精簡的 Fake Mute/Deafen 入口。
- 點擊入口會打開小選單：
  - **Fake Mute**
  - **Fake Deafen**
- 也可在外掛設定頁控制相同功能。
- fake 狀態啟用時，自動重新套用本地麥克風 / 收聽恢復。
- 語音重連或切換頻道後，會再次嘗試恢復本地 media。
- 提供少量 DevTools helper，方便 Discord 更新後檢查狀態。

## 安裝

1. 將此資料夾複製到 Vencord user plugins 目錄：

   ```text
   src/userplugins/fakeMuteDeafenLab
   ```

2. 重新 build Vencord，並重新啟動 Discord。
3. 在 Vencord plugins 中啟用 **FakeMuteDeafenLab**。

在 Vencord 專案根目錄重新 build：

```powershell
cd D:\code\Vencord
node --require=./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs
```

## 使用方式

1. 加入語音頻道。
2. 使用 Discord 原生 Mute / Deafen 按鈕，決定其他人看到的語音狀態。
3. 點擊 FakeMuteDeafenLab 面板按鈕並啟用：
   - **Fake Mute**：當你對外顯示 muted 時，恢復本地語音輸入。
   - **Fake Deafen**：當你對外顯示 deafened 時，恢復本地輸入 / 輸出。
4. 也可以到 **Vencord Settings -> Plugins -> FakeMuteDeafenLab** 控制外掛。

## 可選設定

- **Show quick toggles**：顯示或隱藏左下角 FakeMuteDeafenLab 面板入口。
- **Auto restore local media**：fake 狀態啟用時，定期重新套用本地麥克風 / 收聽恢復。
- **Restore delay**：語音 / media 狀態改變後，等待多久再恢復本地 media。
- **Debug logs**：在 DevTools 顯示簡短日誌。

## DevTools helpers

```js
FakeMuteDeafenLabStatus()
FakeMuteDeafenLabSetMute(true)
FakeMuteDeafenLabSetDeafen(true)
FakeMuteDeafenLabRestoreLocal()
```

## 原理

Discord 有一份對外可見的語音狀態（`selfMute` / `selfDeaf`），也有本地 RTC media connection。此插件現在不再透過 Flux action 改變對外可見狀態，而是在 fake 開關啟用時，呼叫本地 RTC media connection 中可用的方法恢復本地 media。

如果 Discord 更新後外掛失效，通常需要檢查：

- `RTCConnection` module 的偵測條件
- 內部 `_connection` 物件
- `setSelfMute`、`setSelfDeaf`、`setAudioEnabled` 或其他被改名的本地 media 方法
- Discord media connection 行為是否改變
