# thingondesk 投稿文案

## 專案名稱

Afterglow

## 一句話介紹

一款本機優先、免帳號的雙語原生專注工具，把完成的時間變成逐漸亮起的城市；網站由 GitHub Pages 提供試用與原生安裝檔下載。

## 它能做什麼

Afterglow 把 deadline-based 專注計時器、小型任務清單和城市夜景放在同一個安靜的介面。每完成一次專注，城市就會多亮幾扇窗；使用者可以留下簡短回顧與專注感受，再從七日圖表、連續專注天數、最佳專注時段和近期紀錄觀察自己的節奏。

「Timer rhythm」已直接整合進最上方的「Ready when you are」計時卡，不再占用設定區。使用者可在專注、短休息、長休息間切換；專注時間支援 15、25、50 分鐘快速選項，也能直接輸入。所有時間都以 5 分鐘為一級：專注 5–180 分鐘、短休息 5–60 分鐘、長休息 5–90 分鐘，因此加減會依 5、10、15、20 的順序前進，不會出現 6、11、16。

繁體中文／English 的可見切換入口已恢復。功能另包含通知、三種完成音效、Space／R／L 鍵盤快捷鍵、JSON 備份還原、CSV 匯出，以及 Android／iOS 依保存的 `endAt` 排定的本機完成通知；最終送達時間與呈現方式仍由作業系統決定。

## 網站與原生應用程式定位

網站只作為 **browser preview 與原生安裝檔下載中心**，由 `.github/workflows/pages.yml` 建置並發布到 GitHub Pages，不再使用舊預覽網站。專案已移除 PWA manifest、Service Worker、瀏覽器安裝提示及離線 app shell，因此不宣稱網站可安裝、可離線啟動或能長期可靠保存資料。預覽期間使用的 IndexedDB／localStorage 仍可能被瀏覽器清除；持續使用應安裝原生版本。

目前的原生封裝狀態：

- Windows／Linux 使用 Electron。`v0.1.0` 已發布未簽章的 Windows x64 NSIS 安裝檔，以及 Linux x64 AppImage／`.deb`；Windows 版本可能觸發 SmartScreen，三者仍應在乾淨裝置進行人工安裝測試。
- Android／iOS 使用 Capacitor。Android 最低為 Android 8.0／API 26、target API 36；`v0.1.0` 已發布可側載的 debug-signed APK，但乾淨裝置安裝仍應人工測試，穩定覆蓋更新也仍需要私有正式簽章金鑰。
- iOS 目前只有原始碼，仍須在 macOS 使用 Xcode、Apple 簽章與合適的發布管道；沒有可直接安裝的 iOS 檔案。

GitHub Releases workflow 已替 EXE、APK、AppImage、`.deb` 統一命名，產生 SHA-256 與 `availability.json`。`v0.1.0` Release 與 GitHub Pages 已成功發布；Pages 上的 Windows、Linux、Android 按鈕指向同一批 Release 資產，EXE 沒有另外維護一份無法追蹤的副本。尚未完成的 iOS、同步 relay、正式簽章及乾淨裝置安裝測試，投稿與影片仍不可描述成已完成。

## 本機優先與備份

Afterglow 不需要登入。未使用同步時，原生 app 不會上傳個人資料：

- Windows／Linux Electron 把有限制大小的 JSON 紀錄放在 app 專屬 `userData`，透過受限 IPC、暫存檔及 atomic rename 寫入。
- Android／iOS 透過 Capacitor Filesystem 把 JSON 放在 app 私有的 `Directory.LibraryNoCloud`，不把完整紀錄塞進 Preferences，也不把該工作檔納入 iCloud 備份。
- Android／iOS 匯出 JSON 或 CSV 時，先在 app 快取建立檔案，再打開系統 Share 面板。

解除安裝原生 app、替換簽章不相容的 APK 或手動清除 app 資料，仍可能刪除本機紀錄。JSON 備份是可讀檔案，不含同步根金鑰，也不是加密備份；使用者需要自行妥善保存。

## 端對端加密同步：用戶端已實作，本版本未啟用

同步程式已包含 HKDF-SHA-256 金鑰分離、AES-256-GCM envelope、含校驗碼的配對碼、deterministic client-side merge、刪除標記、基本 rollback 偵測與 ETag optimistic concurrency。client 與 Worker 都將加密 envelope 限制為 **4 MiB**。

Electron 透過受限 IPC 傳送二進位密文；Android／iOS 使用 `CapacitorHttp` 的 file/base64 adapter，在不做 UTF-8 轉換的情況下保存精確 bytes，並驗證 base64、限制固定 endpoint、關閉重新導向及設定 timeout。

GitHub Pages 是純靜態託管，無法執行密文中繼服務。本版本因此明確將 `SYNC_RELAY_CONFIGURED` 設為 `false`、隱藏建立與加入同步的操作、停止自動同步請求，也已從 renderer、原生 bridge、CSP 與文件移除舊預覽網址。使用者目前須透過 JSON 備份與匯入移轉資料；頁面不會把尚未部署的同步功能說成可用。

未來若另行部署並完成安全稽核，relay 的設計目標是只保存密文與一般物件中繼資料，不取得根金鑰或可讀任務。屆時也不能稱為「完全沒有雲端」：物件儲存會保存密文，hosting／network provider 仍可能看到 IP、時間和 encrypted payload size；目前發布版則沒有設定 relay。

預計在配對裝置間合併：

- 任務、完成狀態與刪除標記
- 已完成的專注紀錄、意圖、文字回顧與評分
- 每日目標，以及專注、短休息與長休息長度
- 由紀錄重新計算出的每週圖表、連續天數與最佳時段

每台裝置仍各自保留：

- 正在進行的計時、剩餘時間、deadline 與輪次
- 尚未保存的目前意圖
- 完成音效、介面語言與通知狀態
- 本機備份檔與本機時間狀態

配對碼包含唯一根金鑰。任何取得配對碼的人都能讀取或修改共用副本；如果所有已配對裝置與配對碼都遺失，伺服器無法復原。端對端加密也無法保護已被入侵的裝置或在 app 內執行的惡意程式碼。

## 技術重點

- React、TypeScript、Vite 靜態 renderer 與 GitHub Pages
- browser preview／download center；明確移除 PWA manifest、Service Worker 與離線／安裝宣稱
- 整合於主計時卡的 Timer rhythm，以及 5 分鐘級距正規化
- Electron sandboxed renderer、context isolation、受限 IPC、`userData` JSON 與 atomic file replace
- Capacitor Android／iOS：API 26 起、`LibraryNoCloud`、Filesystem／Share、native notification
- `CapacitorHttp` file/base64 binary sync adapter，避免密文被轉成 UTF-8
- Web Crypto：HKDF-SHA-256、AES-256-GCM、opaque locator 與 pairing-code checksum
- 未設定的參考 relay：4 MiB 上限、no-store 回應與 ETag 條件寫入；通過獨立部署與實機驗證前不向使用者開放
- deadline-based 行動裝置計時恢復與可選的 screen wake lock
- 雙語介面、依地區顯示日期、鍵盤操作、reduced motion、焦點管理與自動化測試
- GitHub Actions 原生封裝、GitHub Pages、固定 release asset 名稱、SHA-256 與下載 manifest；`v0.1.0` 已在公開 repository 發布

## 連結

- 預覽／下載中心：https://siriusw823.github.io/afterglow/
- 原始碼：https://github.com/SiriusW823/afterglow
- 展示影片：https://github.com/SiriusW823/afterglow/blob/main/submission/afterglow-demo.mp4
- GitHub Release：https://github.com/SiriusW823/afterglow/releases/tag/v0.1.0
- Windows EXE：https://github.com/SiriusW823/afterglow/releases/download/v0.1.0/afterglow-0.1.0-windows-x64.exe
- Android APK：https://github.com/SiriusW823/afterglow/releases/download/v0.1.0/afterglow-0.1.0-android-debug.apk

## 投稿前檢查清單

- [x] 建立公開 GitHub repository 並設定 `origin`
- [x] 將 GitHub Pages 的 Source 設為 GitHub Actions，並確認公開網址可開啟
- [x] 發布版本化 `v0.1.0` GitHub Release，確認 EXE、AppImage、`.deb`、APK 與 checksum 資產存在
- [x] 確認 Pages workflow 已自動產生 Release 下載清單，網站按鈕指向正確資產
- [ ] 在乾淨的 Windows、Linux 與 Android 裝置實際下載、安裝並啟動各版本
- [ ] 展示影片不出現 PWA／offline 宣稱，不把未啟用的同步或未發布 artifact 說成已可用
- [ ] Hackatime 只列入本人真實投入的開發時間，並提供對應紀錄／commit 證明
- [ ] 投稿表單中的專案名稱、功能範圍、網址與下載狀態完全一致
