# FakeMuteDeafenLab
![image](https://github.com/hoho087/vencord-FakeMuteDeafenLab/blob/main/image.png)

A Vencord user plugin that displays your Discord voice state as muted/deafened while restoring the local RTC media connection.

## Features

- Quick Fake Mute / Fake Deafen buttons near Discord's lower-left voice controls.
- Plugin settings page controls for the same toggles.
- Automatic local mic/listen restoration after voice reconnects or channel switches.
- Small DevTools helpers for status checks after Discord updates.

## Installation

1. Copy this folder to your Vencord user plugins directory:

   ```text
   src/userplugins/fakeMuteDeafenLab
   ```

2. Build Vencord and restart Discord.
3. Enable **FakeMuteDeafenLab** in Vencord plugins.

## Usage

1. Join a voice channel.
2. Use the two quick buttons near the lower-left voice controls:
   - **Fake Mute**: shows you as muted while restoring local voice input.
   - **Fake Deafen**: shows you as deafened while restoring local input/output.
3. You can also control the plugin from **Vencord Settings → Plugins → FakeMuteDeafenLab**.

Optional settings:

- **Show quick toggles**: show or hide the lower-left buttons.
- **Auto restore local media**: periodically re-apply local mic/listen restoration.
- **Restore delay**: delay before local media is restored after a visible state change.
- **Debug logs**: print concise logs to DevTools.

## DevTools helpers

```js
FakeMuteDeafenLabStatus()
FakeMuteDeafenLabSetMute(true)
FakeMuteDeafenLabSetDeafen(true)
FakeMuteDeafenLabRestoreLocal()
```

## How it works

Discord has a visible voice state (`selfMute` / `selfDeaf`) and a local RTC media connection. This plugin updates the visible voice state through Discord's normal Flux actions, then restores the local media connection with the available RTC media methods.

If a Discord update breaks the plugin, the most likely areas to inspect are:

- `RTCConnection` module detection
- the internal `_connection` object
- local media methods such as `setSelfMute`, `setSelfDeaf`, `setAudioEnabled`, or renamed equivalents
- Flux actions used for visible voice state changes

---

# FakeMuteDeafenLab（繁體中文）

這是一個 Vencord user plugin，可讓 Discord 的語音狀態顯示為 muted / deafened，同時恢復本地 RTC media connection。

## 功能

- 在 Discord 左下角語音控制附近加入 Fake Mute / Fake Deafen 快捷按鈕。
- 也可在外掛設定頁控制相同功能。
- 語音重連或切換頻道後，會自動重新套用本地麥克風 / 收聽恢復。
- 提供少量 DevTools helper，方便 Discord 更新後檢查狀態。

## 安裝

1. 將此資料夾複製到 Vencord user plugins 目錄：

   ```text
   src/userplugins/fakeMuteDeafenLab
   ```

2. 重新 build Vencord，並重新啟動 Discord。
3. 在 Vencord plugins 中啟用 **FakeMuteDeafenLab**。

## 使用方式

1. 加入語音頻道。
2. 使用左下角語音控制旁的兩個快捷按鈕：
   - **Fake Mute**：對外顯示 muted，同時恢復本地語音輸入。
   - **Fake Deafen**：對外顯示 deafened，同時恢復本地輸入 / 輸出。
3. 也可以到 **Vencord Settings → Plugins → FakeMuteDeafenLab** 控制外掛。

可選設定：

- **Show quick toggles**：顯示或隱藏左下角快捷按鈕。
- **Auto restore local media**：定期重新套用本地麥克風 / 收聽恢復。
- **Restore delay**：可見狀態改變後，等待多久再恢復本地 media。
- **Debug logs**：在 DevTools 顯示簡短日誌。

## DevTools helpers

```js
FakeMuteDeafenLabStatus()
FakeMuteDeafenLabSetMute(true)
FakeMuteDeafenLabSetDeafen(true)
FakeMuteDeafenLabRestoreLocal()
```

## 原理

Discord 有一份對外可見的語音狀態（`selfMute` / `selfDeaf`），也有本地 RTC media connection。此插件會先透過 Discord 原有的 Flux actions 更新可見語音狀態，再呼叫本地 RTC media connection 中可用的方法恢復本地 media。

如果 Discord 更新後外掛失效，通常需要檢查：

- `RTCConnection` module 的偵測條件
- 內部 `_connection` 物件
- `setSelfMute`、`setSelfDeaf`、`setAudioEnabled` 或其他被改名的本地 media 方法
- 用於可見語音狀態切換的 Flux actions
