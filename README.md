# voicerec

## Overview
voicerec is a mobile voice recording app built with Expo (React Native). It records audio, saves it locally, and automatically uploads recordings to a companion server ([voicerec-server](https://github.com/daishir0/voicerec-server)) using **Bearer token authentication**. Audio is recorded in one of two Whisper-optimized presets (standard or high quality) and, on the server side, is automatically transcribed by both gpt-4o-transcribe (for high-quality full text) and whisper-1 (for sentence-level segments with absolute timestamps).

Key features:
- One-tap voice recording with real-time timer display
- **Two recording quality presets**, togglable from the settings screen:
  - **Standard** (default): M4A/AAC, 12kHz mono, 16kbps — ~120KB/min (smallest, Whisper-compatible)
  - **High quality**: M4A/AAC, 16kHz mono, 32kbps — ~240KB/min (better accuracy, still efficient)
- Automatic fallback to iOS HIGH_QUALITY preset if the selected preset fails on the device, **reset on every new recording** so a single failure never silently pins subsequent recordings to fallback mode
- User-facing alert + in-app debug log when fallback is triggered, including the underlying error message
- **Bearer token authentication** — first login exchanges username/password for a token via `POST /api/auth/login`, token is stored in `AsyncStorage`, and subsequent uploads use `Authorization: Bearer <token>`
- Automatic re-login when the stored token is missing or rejected (401)
- Auto-upload to companion server with retry on failure
- Background recording support (audio continues when screen is off)
- Recording list with upload status indicators (waiting / uploading / uploaded / failed)
- Debug mode toggle in settings with an in-app log viewer for upload/fallback diagnostics
- Dark mode support

## Installation

1. Clone the repository:
```bash
git clone https://github.com/daishir0/voicerec.git
cd voicerec
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env and set EXPO_PUBLIC_SERVER_URL to your voicerec-server instance
```

4. Start the development server:
```bash
npx expo start --port 18082
```

5. Open Expo Go on your iPhone/Android and scan the QR code.

For production (TestFlight / App Store), use [EAS Build](https://docs.expo.dev/build/introduction/) instead of Expo Go.

## Usage

### Settings
Tap the gear icon in the header to open the settings screen. Configure:
- **Server URL** — the URL of your voicerec-server instance
- **Username / Password** — your voicerec-server user credentials (used for the first login; after that, the Bearer token is stored and reused)
- **Recording quality** — toggle between "Standard" (default, smallest size) and "High quality" (better accuracy for Whisper)
- **Debug mode** — enables the in-app log viewer for upload and fallback diagnostics
- **Test Connection** — verifies that the server is reachable and credentials are valid (performs a login if no token is stored)

### Recording
1. Tap the red button to start recording
2. The timer shows elapsed time in real-time (updated every 500 ms)
3. Tap again to stop — the recording is automatically saved and queued for upload
4. Recording continues even when the screen is turned off (uses `allowsBackgroundRecording`)
5. If the selected preset fails on device, an alert is shown (e.g. "音質低下") and recording continues in the iOS HIGH_QUALITY fallback preset. The fallback is reset at the start of the next recording so a single failure does not persist.

### Recording List
- View all recordings in the list tab
- Status badges show upload progress:
  - **Gray**: waiting to upload
  - **Blue**: uploading
  - **Green**: uploaded successfully
  - **Red**: upload failed (will retry automatically when the app is next active)
- Tap a recording to edit its display name
- Swipe or tap delete to remove a recording

### Authentication flow
1. On first upload after entering credentials in Settings, the app calls `POST /api/auth/login` with username + password and receives a Bearer token
2. The token is saved to `AsyncStorage` and all subsequent requests use `Authorization: Bearer <token>`
3. If the server returns 401 (e.g. token revoked server-side), the app automatically re-logs in using the stored username/password and stores the new token
4. The previously used **Basic Auth** flow has been completely removed from the app and from the server

## Notes

- Requires [voicerec-server](https://github.com/daishir0/voicerec-server) 0.2.0 or later (Bearer token endpoints)
- Tested on iOS via Expo Go SDK 54 and TestFlight (EAS Build)
- Audio is recorded in M4A/AAC format; the server transcribes every upload twice (gpt-4o-transcribe + whisper-1)
- **Username/password are stored locally** in `AsyncStorage` for automatic re-login on token expiry; the Bearer token is also stored in `AsyncStorage`
- For production deployment, build a standalone app with EAS Build instead of Expo Go
- When changing `version` or `iOS buildNumber` in `app.json`, commit the change before requesting an EAS Build — **EAS builds from the latest git commit, not from local files**

## License
This project is licensed under the MIT License — see the LICENSE file.

---

# voicerec

## 概要
voicerec は Expo (React Native) で構築されたモバイル音声録音アプリです。音声を録音してローカルに保存し、コンパニオンサーバー ([voicerec-server](https://github.com/daishir0/voicerec-server)) に **Bearer トークン認証** で自動アップロードします。音声は 2 つの Whisper 最適化プリセット (通常/高品質) のいずれかで録音され、サーバー側では gpt-4o-transcribe (高品質な全文) と whisper-1 (絶対時刻付き発話単位セグメント) の両方で自動文字起こしされます。

主な機能:
- ワンタップ録音とリアルタイムタイマー表示
- **2種類の録音品質プリセット** (設定画面から切替):
  - **通常** (デフォルト): M4A/AAC, 12kHz モノラル, 16kbps — 約120KB/分 (最小サイズ、Whisper 互換)
  - **高品質**: M4A/AAC, 16kHz モノラル, 32kbps — 約240KB/分 (精度向上、それでも効率的)
- 選択したプリセットが端末で失敗した場合、iOS HIGH_QUALITY プリセットに自動フォールバック。**新しい録音のたびにフォールバック状態はリセットされる** ため、一度の失敗が以降の録音に持ち越されることはありません
- フォールバック発動時にはユーザーへアラート + アプリ内デバッグログへ原因エラー文字列を出力
- **Bearer トークン認証** — 初回ログインで username/password を `POST /api/auth/login` に送ってトークンを取得、`AsyncStorage` に保存し、以降のアップロードは `Authorization: Bearer <token>` で実施
- 保存済みトークンが無い or 401 で拒否された場合は自動的に再ログイン
- コンパニオンサーバーへの自動アップロード (失敗時リトライ付き)
- バックグラウンド録音対応 (画面オフ時も録音継続)
- アップロードステータス付き録音一覧 (待機中 / アップロード中 / アップロード済み / 失敗)
- 設定画面のデバッグモード切替とアプリ内ログビューア (アップロード・フォールバックの診断用)
- ダークモード対応

## インストール方法

1. リポジトリをクローン:
```bash
git clone https://github.com/daishir0/voicerec.git
cd voicerec
```

2. 依存関係をインストール:
```bash
npm install
```

3. 環境変数を設定:
```bash
cp .env.example .env
# .env を編集し、EXPO_PUBLIC_SERVER_URL に voicerec-server の URL を設定
```

4. 開発サーバーを起動:
```bash
npx expo start --port 18082
```

5. iPhone または Android で Expo Go を開き QR コードをスキャン。

本番 (TestFlight / App Store) 配布には [EAS Build](https://docs.expo.dev/build/introduction/) を使用してください。

## 使い方

### 設定
ヘッダーの歯車アイコンをタップして設定画面を開きます。以下を設定:
- **サーバー URL** — voicerec-server の URL
- **ユーザー名 / パスワード** — voicerec-server のユーザー認証情報 (初回ログインで使用。以降は Bearer トークンが保存され再利用される)
- **録音品質** — 「通常」 (既定、最小サイズ) と「高品質」 (Whisper 精度向上) の切替
- **デバッグモード** — アプリ内のログビューアを有効化 (アップロードやフォールバックの診断用)
- **テスト接続** — サーバー到達性と認証情報の妥当性を検証 (トークン未保存時はログインを実行)

### 録音
1. 赤いボタンをタップして録音開始
2. タイマーにリアルタイムで経過時間を表示 (500ms 間隔で更新)
3. 再度タップで停止 — 録音は自動保存され、アップロードキューに追加
4. 画面オフ時も録音を継続 (`allowsBackgroundRecording`)
5. 選択したプリセットが端末で失敗した場合、「音質低下」などのアラートが表示され、iOS HIGH_QUALITY プリセットで録音継続します。フォールバックは次の録音開始時にリセットされるので、一度の失敗が持ち越されることはありません。

### 録音一覧
- リストタブですべての録音を確認
- ステータスバッジでアップロード状況を表示:
  - **グレー**: アップロード待機中
  - **青**: アップロード中
  - **緑**: アップロード完了
  - **赤**: アップロード失敗 (次回アプリ起動時に自動リトライ)
- 録音をタップして表示名を編集
- スワイプまたは削除ボタンで録音を削除

### 認証フロー
1. 設定で認証情報を入力後の初回アップロード時、アプリは `POST /api/auth/login` に username + password を送信し Bearer トークンを取得
2. トークンは `AsyncStorage` に保存され、以降のリクエストは `Authorization: Bearer <token>` で実施
3. サーバーが 401 を返した場合 (サーバー側でトークンが失効されたなど)、保存済みの username/password で自動的に再ログインし新しいトークンを保存
4. 以前の **Basic 認証** フローはアプリ側・サーバー側ともに完全削除済み

## 注意点

- バックエンドとして [voicerec-server](https://github.com/daishir0/voicerec-server) 0.2.0 以降が必要 (Bearer トークンエンドポイント対応版)
- iOS で Expo Go SDK 54 および TestFlight (EAS Build) で動作確認済み
- 音声は M4A/AAC 形式で録音され、サーバーはアップロードごとに gpt-4o-transcribe と whisper-1 の両方で文字起こしを実行します
- **ユーザー名/パスワードはトークン失効時の自動再ログイン用に** `AsyncStorage` にローカル保存されます。Bearer トークンも同じく `AsyncStorage` に保存されます
- 本番デプロイでは、Expo Go ではなく EAS Build でスタンドアロンアプリをビルドしてください
- `app.json` の `version` や iOS の `buildNumber` を変更したら、**EAS Build を依頼する前に必ずコミットしてください**。EAS は最新の git commit からビルドするため、未コミットの変更は反映されません

## ライセンス
このプロジェクトは MIT ライセンスの下でライセンスされています。詳細は LICENSE ファイルを参照してください。
