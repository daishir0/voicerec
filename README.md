# voicerec

## Overview
voicerec is a mobile voice recording app built with Expo (React Native). It records audio, saves it locally, and automatically uploads recordings to a companion server ([voicerec-server](https://github.com/daishir0/voicerec-server)). The audio format is optimized for OpenAI Whisper speech-to-text with minimal file sizes.

Key features:
- One-tap voice recording with real-time timer display
- Whisper-optimized audio format (M4A/AAC, 12kHz, mono, 16kbps — ~120KB/min)
- Automatic fallback to high-quality recording if the device doesn't support the low-bitrate preset
- Auto-upload to companion server with retry on failure
- Background recording support (continues when screen is off)
- Recording list with upload status indicators (waiting / uploading / uploaded / failed)
- Server connection test from settings screen
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
# Edit .env with your server URL
```

4. Start the development server:
```bash
npx expo start --port 18082
```

5. Open Expo Go on your iPhone/Android and scan the QR code.

## Usage

### Settings
Tap the gear icon in the header to open the settings screen. Configure:
- **Server URL**: The URL of your voicerec-server instance
- **Username / Password**: Your app user credentials
- **Test Connection**: Verify that the server is reachable and credentials are correct

### Recording
1. Tap the red button to start recording
2. The timer shows elapsed time in real-time
3. Tap again to stop — the recording is automatically saved and queued for upload
4. Recording continues even when the screen is turned off

### Recording List
- View all recordings in the list tab
- Status badges show upload progress:
  - **Gray**: Waiting to upload
  - **Blue**: Uploading
  - **Green**: Successfully uploaded
  - **Red**: Upload failed (will retry automatically on next app launch)
- Tap a recording to edit its display name
- Swipe or tap delete to remove a recording

## Notes
- Requires [voicerec-server](https://github.com/daishir0/voicerec-server) as the backend
- Tested with Expo Go SDK 54 on iOS
- Audio is recorded in M4A/AAC format optimized for Whisper (12kHz, mono, 16kbps)
- If the device doesn't support the low-bitrate preset, it automatically falls back to high-quality (44.1kHz, stereo, 128kbps)
- User credentials are stored locally on the device via AsyncStorage
- For production deployment, consider building a standalone app with EAS Build instead of using Expo Go

## License
This project is licensed under the MIT License - see the LICENSE file for details.

---

# voicerec

## 概要
voicerecは、Expo（React Native）で構築されたモバイル音声録音アプリです。音声を録音してローカルに保存し、コンパニオンサーバー（[voicerec-server](https://github.com/daishir0/voicerec-server)）に自動アップロードします。音声フォーマットはOpenAI Whisper音声認識に最適化され、最小限のファイルサイズを実現しています。

主な機能:
- ワンタップ録音とリアルタイムタイマー表示
- Whisper最適化音声フォーマット（M4A/AAC, 12kHz, モノラル, 16kbps — 約120KB/分）
- デバイスが低ビットレートプリセットに非対応の場合、高品質録音に自動フォールバック
- コンパニオンサーバーへの自動アップロード（失敗時リトライ付き）
- バックグラウンド録音対応（画面オフ時も録音継続）
- アップロードステータス付き録音一覧（待機中 / アップロード中 / アップロード済み / 失敗）
- 設定画面からのサーバー接続テスト
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
# .envを編集してサーバーURLを設定
```

4. 開発サーバーを起動:
```bash
npx expo start --port 18082
```

5. iPhoneまたはAndroidでExpo Goを開き、QRコードをスキャン。

## 使い方

### 設定
ヘッダーの歯車アイコンをタップして設定画面を開きます。以下を設定:
- **サーバーURL**: voicerec-serverのURL
- **ユーザー名 / パスワード**: アプリユーザーの認証情報
- **テスト接続**: サーバーへの接続と認証情報の確認

### 録音
1. 赤いボタンをタップして録音開始
2. タイマーにリアルタイムで経過時間を表示
3. 再度タップで停止 — 録音は自動保存され、アップロードキューに追加
4. 画面オフ時も録音を継続

### 録音一覧
- リストタブで全録音を確認
- ステータスバッジでアップロード状況を表示:
  - **グレー**: アップロード待機中
  - **青**: アップロード中
  - **緑**: アップロード完了
  - **赤**: アップロード失敗（次回アプリ起動時に自動リトライ）
- 録音をタップして表示名を編集
- スワイプまたは削除ボタンで録音を削除

## 注意点
- バックエンドとして[voicerec-server](https://github.com/daishir0/voicerec-server)が必要です
- Expo Go SDK 54（iOS）でテスト済み
- 音声はWhisper向けに最適化されたM4A/AAC形式で録音（12kHz, モノラル, 16kbps）
- デバイスが低ビットレートプリセットに対応していない場合、高品質（44.1kHz, ステレオ, 128kbps）に自動フォールバック
- ユーザー認証情報はAsyncStorageを使用してデバイスにローカル保存
- 本番デプロイでは、Expo Goの代わりにEAS Buildでスタンドアロンアプリをビルドすることを推奨

## ライセンス
このプロジェクトはMITライセンスの下でライセンスされています。詳細はLICENSEファイルを参照してください。
